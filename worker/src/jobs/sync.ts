// The "sync" job: copy the open pull requests of a project's repositories,
// and the files each one changes, from GitHub into D1.
//
// Enqueue it with `POST /api/projects/{id}/jobs {"kind": "sync"}`. `target`
// may name one repo ("owner/name"); empty means every repo of the project.
// Safe to run again and again: rows are upserted by (repo, PR number), a PR's
// files are only re-read when its head commit moved, and PRs that are no
// longer open on GitHub are marked closed.
import type { Bindings } from "../env";
import { AppError } from "../error";
import { appConfigFromEnv, ghHeaders, installationToken, type AppConfig } from "../github-app";
import { PermanentError, registerHandler, type JobHandler } from "./queue";

export const SYNC_KIND = "sync";
const PAGE_SIZE = 100;
/** GitHub stops listing a PR's files after 3000. */
const MAX_FILE_PAGES = 30;
/** D1 allows 100 bound values per statement. */
const FILE_ROWS_PER_INSERT = 12;

interface GhPull {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft?: boolean;
  html_url: string;
  user: { login: string } | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  created_at: string;
  updated_at: string;
}

interface GhFile {
  filename: string;
  status: string;
  previous_filename?: string;
  additions: number;
  deletions: number;
}

interface RepoRow {
  id: string;
  full_name: string;
}

async function ghPages<T>(app: AppConfig, token: string, what: string, path: string, maxPages = Infinity): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = path.includes("?") ? "&" : "?";
    let res: Response;
    try {
      res = await fetch(`${app.apiUrl}${path}${sep}per_page=${PAGE_SIZE}&page=${page}`, { headers: ghHeaders(token) });
    } catch (cause) {
      throw new AppError("upstream", `GitHub ${what}: ${String(cause)}`, { cause });
    }
    if (res.status === 404) throw new PermanentError(`GitHub ${what}: not found (is the app installed on this repository?)`);
    if (!res.ok) throw new AppError("upstream", `GitHub ${what}: status ${res.status}`);
    const batch = (await res.json()) as T[];
    out.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return out;
}

/** The installation that owns a repo: one of the project owner's installations on the repo's account. */
async function installationFor(env: Bindings, projectId: string, fullName: string): Promise<number | null> {
  const owner = fullName.split("/")[0] ?? "";
  const row = await env.DB.prepare(
    `SELECT gi.id FROM github_installations gi
       JOIN user_installations ui ON ui.installation_id = gi.id
       JOIN projects p ON p.owner_id = ui.user_id
      WHERE p.id = ?1 AND gi.account_login = ?2 COLLATE NOCASE
      ORDER BY gi.id LIMIT 1`,
  )
    .bind(projectId, owner)
    .first<{ id: number }>();
  return row?.id ?? null;
}

async function syncRepo(env: Bindings, app: AppConfig, projectId: string, repo: RepoRow, progress: (n: number) => Promise<void>): Promise<number> {
  const installationId = await installationFor(env, projectId, repo.full_name);
  if (installationId === null) throw new PermanentError(`no GitHub App installation for ${repo.full_name}; install the app on its owner first`);
  const token = await installationToken(app, installationId);
  if (token === null) throw new PermanentError(`GitHub no longer knows installation ${installationId}`);

  const pulls = await ghPages<GhPull>(app, token, `pulls of ${repo.full_name}`, `/repos/${repo.full_name}/pulls?state=open&sort=created&direction=asc`);
  const known = new Map(
    (
      await env.DB.prepare("SELECT id, number, head_sha FROM pull_requests WHERE repo_id = ?1")
        .bind(repo.id)
        .all<{ id: string; number: number; head_sha: string }>()
    ).results.map((r) => [r.number, r]),
  );

  for (const pr of pulls) {
    const before = known.get(pr.number);
    // Files only change with the head commit; skip the extra requests when it has not moved.
    const files = before?.head_sha === pr.head.sha ? null : await ghPages<GhFile>(app, token, `files of ${repo.full_name}#${pr.number}`, `/repos/${repo.full_name}/pulls/${pr.number}/files`, MAX_FILE_PAGES);
    const id = before?.id ?? crypto.randomUUID();
    const stats = files
      ? { additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0), changed: files.length }
      : null;

    const statements: D1PreparedStatement[] = [
      env.DB.prepare(
        `INSERT INTO pull_requests (id, repo_id, number, github_pr_id, title, body, author_login, state, draft, head_ref, head_sha, base_ref, html_url,
                                    additions, deletions, changed_files, github_created_at, github_updated_at, synced_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'open', ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT (repo_id, number) DO UPDATE SET
           github_pr_id = excluded.github_pr_id, title = excluded.title, body = excluded.body, author_login = excluded.author_login,
           state = 'open', draft = excluded.draft, head_ref = excluded.head_ref, head_sha = excluded.head_sha, base_ref = excluded.base_ref,
           html_url = excluded.html_url,
           additions = CASE WHEN ?18 THEN excluded.additions ELSE additions END,
           deletions = CASE WHEN ?18 THEN excluded.deletions ELSE deletions END,
           changed_files = CASE WHEN ?18 THEN excluded.changed_files ELSE changed_files END,
           github_created_at = excluded.github_created_at, github_updated_at = excluded.github_updated_at, synced_at = excluded.synced_at`,
      ).bind(
        id, repo.id, pr.number, pr.id, pr.title, pr.body ?? "", pr.user?.login ?? "", pr.draft ? 1 : 0, pr.head.ref, pr.head.sha, pr.base.ref, pr.html_url,
        stats?.additions ?? 0, stats?.deletions ?? 0, stats?.changed ?? 0, pr.created_at, pr.updated_at, stats ? 1 : 0,
      ),
    ];
    if (files) {
      statements.push(env.DB.prepare("DELETE FROM pr_files WHERE pull_request_id = ?1").bind(id));
      for (let i = 0; i < files.length; i += FILE_ROWS_PER_INSERT) {
        const chunk = files.slice(i, i + FILE_ROWS_PER_INSERT);
        const values = chunk.map((_, k) => `(?1, ?${k * 5 + 2}, ?${k * 5 + 3}, ?${k * 5 + 4}, ?${k * 5 + 5}, ?${k * 5 + 6})`).join(", ");
        statements.push(
          env.DB.prepare(`INSERT OR REPLACE INTO pr_files (pull_request_id, path, status, previous_path, additions, deletions) VALUES ${values}`).bind(
            id,
            ...chunk.flatMap((f) => [f.filename, f.status, f.previous_filename ?? null, f.additions, f.deletions]),
          ),
        );
      }
    }
    // One batch is one transaction: a PR never shows half its files.
    await env.DB.batch(statements);
    await progress(pr.number);
  }

  // Anything stored as open that GitHub no longer lists was merged or closed.
  const open = new Set(pulls.map((p) => p.number));
  const gone = [...known.keys()].filter((n) => !open.has(n));
  if (gone.length) {
    await env.DB.batch(
      gone.map((n) => env.DB.prepare("UPDATE pull_requests SET state = 'closed', synced_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE repo_id = ?1 AND number = ?2 AND state = 'open'").bind(repo.id, n)),
    );
  }
  return pulls.length;
}

export const syncHandler: JobHandler = async (job, ctx) => {
  const app = appConfigFromEnv(ctx.env);
  const target = job.target.trim();
  const { results: repos } = target
    ? await ctx.env.DB.prepare("SELECT id, full_name FROM project_repos WHERE project_id = ?1 AND full_name = ?2 COLLATE NOCASE").bind(job.project_id, target).all<RepoRow>()
    : await ctx.env.DB.prepare("SELECT id, full_name FROM project_repos WHERE project_id = ?1 ORDER BY full_name").bind(job.project_id).all<RepoRow>();
  if (target && repos.length === 0) throw new PermanentError(`${target} is not a repository of this project`);

  let total = 0;
  for (const repo of repos) {
    const count = await syncRepo(ctx.env, app, job.project_id, repo, (number) => ctx.progress({ repo: repo.full_name, pr: number }));
    total += count;
    await ctx.progress({ repo: repo.full_name, openPullRequests: count });
  }
  await ctx.progress({ repos: repos.length, openPullRequests: total });
};

registerHandler(SYNC_KIND, syncHandler);
