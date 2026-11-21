// The "sync" job: copy the open pull requests of a project's repositories,
// and the files each one changes, from GitHub into D1.
//
// Enqueue it with `POST /api/projects/{id}/jobs {"kind": "sync"}`. `target`
// may name one repo ("owner/name"); empty means every repo of the project.
// Safe to run again and again: rows are upserted by (repo, PR number), a PR's
// files are only re-read when its head commit moved, and PRs that are no
// longer open on GitHub are marked closed (with `merged_at` when merged).
import type { Bindings } from "../env";
import { AppError } from "../error";
import { appConfigFromEnv, ghHeaders, installationToken, linkRepoInstallation, type AppConfig } from "../github-app";
import { pullStatements, type GhFile, type GhPull } from "../pulls";
import { PermanentError, registerHandler, type JobHandler } from "./queue";

export const SYNC_KIND = "sync";
const PAGE_SIZE = 100;
/** GitHub stops listing a PR's files after 3000. */
const MAX_FILE_PAGES = 30;
/** How many pages (of 100) of recently closed PRs a sync reads. */
const RECENT_CLOSED_PAGES = 1;

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
export async function installationFor(env: Bindings, projectId: string, fullName: string): Promise<number | null> {
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

/** When a PR was merged, or null if it was closed unmerged (or GitHub cannot say). */
async function mergedAtOf(app: AppConfig, token: string, fullName: string, number: number): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(`${app.apiUrl}/repos/${fullName}/pulls/${number}`, { headers: ghHeaders(token) });
  } catch (cause) {
    throw new AppError("upstream", `GitHub ${fullName}#${number}: ${String(cause)}`, { cause });
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new AppError("upstream", `GitHub ${fullName}#${number}: status ${res.status}`);
  return ((await res.json()) as GhPull).merged_at ?? null;
}

async function syncRepo(env: Bindings, app: AppConfig, projectId: string, repo: RepoRow, progress: (n: number) => Promise<void>): Promise<number> {
  let installationId = await installationFor(env, projectId, repo.full_name);
  if (installationId === null) {
    const owner = await env.DB.prepare("SELECT owner_id FROM projects WHERE id = ?1").bind(projectId).first<{ owner_id: string }>();
    if (owner) installationId = await linkRepoInstallation(app, env.DB, owner.owner_id, repo.full_name);
  }
  if (installationId === null) throw new PermanentError(`no GitHub App installation for ${repo.full_name}; install the app on its owner first`);
  const token = await installationToken(app, installationId);
  if (token === null) throw new PermanentError(`GitHub no longer knows installation ${installationId}`);

  const pulls = await ghPages<GhPull>(app, token, `pulls of ${repo.full_name}`, `/repos/${repo.full_name}/pulls?state=open&sort=created&direction=asc`);
  const known = new Map(
    (
      await env.DB.prepare("SELECT id, number, files_sha FROM pull_requests WHERE repo_id = ?1")
        .bind(repo.id)
        .all<{ id: string; number: number; files_sha: string | null }>()
    ).results.map((r) => [r.number, r]),
  );

  for (const pr of pulls) {
    const before = known.get(pr.number);
    // Files only change with the head commit; skip the extra requests when they were already read for this one.
    const files = before?.files_sha === pr.head.sha ? null : await ghPages<GhFile>(app, token, `files of ${repo.full_name}#${pr.number}`, `/repos/${repo.full_name}/pulls/${pr.number}/files`, MAX_FILE_PAGES);
    // One batch is one transaction: a PR never shows half its files.
    await env.DB.batch(pullStatements(env, repo.id, before?.id ?? crypto.randomUUID(), pr, files));
    await progress(pr.number);
  }

  // Recently closed PRs, so merged ones show up even if we never saw them open. The list endpoint carries
  // `merged_at`; files are not read for these.
  const closed = await ghPages<GhPull>(app, token, `closed pulls of ${repo.full_name}`, `/repos/${repo.full_name}/pulls?state=closed&sort=updated&direction=desc`, RECENT_CLOSED_PAGES);
  for (const pr of closed) {
    await env.DB.batch(pullStatements(env, repo.id, known.get(pr.number)?.id ?? crypto.randomUUID(), pr, null));
  }

  // Anything stored as open that GitHub no longer lists was merged or closed;
  // ask GitHub which, so the inbox can tell "Merged" from closed.
  const open = new Set(pulls.map((p) => p.number));
  const closedNow = new Set(closed.map((p) => p.number));
  const gone = [...known.keys()].filter((n) => !open.has(n) && !closedNow.has(n));
  for (const n of gone) {
    const mergedAt = await mergedAtOf(app, token, repo.full_name, n);
    await env.DB.prepare(
      `UPDATE pull_requests SET state = 'closed', merged_at = ?3, synced_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE repo_id = ?1 AND number = ?2 AND state = 'open'`,
    )
      .bind(repo.id, n, mergedAt)
      .run();
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
