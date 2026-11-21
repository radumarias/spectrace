// Storing pull requests: the one place that writes `pull_requests` and
// `pr_files`. The sync job (T2.1) and the webhook endpoint (T2.2) both use it.
import type { Bindings } from "./env";

/** The parts of GitHub's pull request object that we store (REST list and webhook payload alike). */
export interface GhPull {
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
  /** Set when the PR was merged (single-PR object and webhooks; the list endpoint leaves it out). */
  merged_at?: string | null;
  /** Only the single-PR object (and so webhooks) has these; the list endpoint does not. */
  additions?: number;
  deletions?: number;
  changed_files?: number;
}

export interface GhFile {
  filename: string;
  status: string;
  previous_filename?: string;
  additions: number;
  deletions: number;
  /** GitHub's unified diff; left out for binary files and for diffs it finds too large. */
  patch?: string;
}

/** Longest diff kept for one file. Longer ones are shown as "too large" with a link to GitHub. */
export const MAX_PATCH_CHARS = 60_000;

/** D1 allows 100 bound values per statement. */
const FILE_ROWS_PER_INSERT = 12;

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/**
 * Statements that store one PR, and its files when they were just read. Run
 * them in one `DB.batch` (one transaction); the first statement is the PR
 * upsert, so its `meta.changes` says whether the PR changed.
 *
 * A PR is only overwritten by data at least as new as what is stored
 * (`updated_at`), so webhooks delivered out of order cannot roll it back.
 * Without `files` the stored files, their `files_sha` and (unless GitHub sent
 * counts) the line counts are left alone.
 */
export function pullStatements(env: Bindings, repoId: string, id: string, pr: GhPull, files: GhFile[] | null): D1PreparedStatement[] {
  const stats = files
    ? { additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0), changed: files.length }
    : pr.additions !== undefined && pr.deletions !== undefined && pr.changed_files !== undefined
      ? { additions: pr.additions, deletions: pr.deletions, changed: pr.changed_files }
      : null;

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO pull_requests (id, repo_id, number, github_pr_id, title, body, author_login, state, draft, head_ref, head_sha, base_ref, html_url,
                                  additions, deletions, changed_files, github_created_at, github_updated_at, synced_at, files_sha, merged_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ${NOW}, ?20, ?21)
       ON CONFLICT (repo_id, number) DO UPDATE SET
         github_pr_id = excluded.github_pr_id, title = excluded.title, body = excluded.body, author_login = excluded.author_login,
         state = excluded.state, draft = excluded.draft, head_ref = excluded.head_ref, head_sha = excluded.head_sha, base_ref = excluded.base_ref,
         html_url = excluded.html_url,
         additions = CASE WHEN ?19 THEN excluded.additions ELSE additions END,
         deletions = CASE WHEN ?19 THEN excluded.deletions ELSE deletions END,
         changed_files = CASE WHEN ?19 THEN excluded.changed_files ELSE changed_files END,
         github_created_at = excluded.github_created_at, github_updated_at = excluded.github_updated_at, synced_at = excluded.synced_at,
         files_sha = COALESCE(excluded.files_sha, files_sha), merged_at = excluded.merged_at
       WHERE excluded.github_updated_at >= pull_requests.github_updated_at`,
    ).bind(
      id, repoId, pr.number, pr.id, pr.title, pr.body ?? "", pr.user?.login ?? "", pr.state === "open" ? "open" : "closed", pr.draft ? 1 : 0,
      pr.head.ref, pr.head.sha, pr.base.ref, pr.html_url,
      stats?.additions ?? 0, stats?.deletions ?? 0, stats?.changed ?? 0, pr.created_at, pr.updated_at, stats ? 1 : 0,
      files ? pr.head.sha : null, pr.merged_at ?? null,
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
    // One statement per diff: they are big, and most files have one.
    for (const f of files) {
      if (f.patch && f.patch.length <= MAX_PATCH_CHARS) {
        statements.push(env.DB.prepare("UPDATE pr_files SET patch = ?3 WHERE pull_request_id = ?1 AND path = ?2").bind(id, f.filename, f.patch));
      }
    }
  }
  return statements;
}

export interface StoredPull {
  id: string;
  /** False when GitHub's data was older than what is stored, so nothing changed. */
  changed: boolean;
  /** The files of the stored head commit have not been read yet (new PR, or the head moved): a sync is due. */
  filesStale: boolean;
}

/** Store a PR from a webhook payload (no files) and say what changed. */
export async function upsertPullFromWebhook(env: Bindings, repoId: string, pr: GhPull): Promise<StoredPull> {
  const before = await env.DB.prepare("SELECT id FROM pull_requests WHERE repo_id = ?1 AND number = ?2").bind(repoId, pr.number).first<{ id: string }>();
  const id = before?.id ?? crypto.randomUUID();
  const [upsert] = await env.DB.batch(pullStatements(env, repoId, id, pr, null));
  const changed = (upsert?.meta.changes ?? 0) > 0;
  const row = await env.DB.prepare("SELECT head_sha, files_sha FROM pull_requests WHERE id = ?1").bind(id).first<{ head_sha: string; files_sha: string | null }>();
  return { id, changed, filesStale: row !== null && row.files_sha !== row.head_sha };
}
