// The "sync" job: copy the open pull requests of a project's repositories,
// and the files each one changes, from GitHub or GitLab into D1.
//
// Enqueue it with `POST /api/projects/{id}/jobs {"kind": "sync"}`. `target`
// may name one repo ("owner/name"); empty means every repo of the project.
// Safe to run again and again: rows are upserted by (repo, PR number), a PR's
// files are only re-read when its head commit moved, and PRs that are no
// longer open on the host are marked closed (with `merged_at` when merged).
import type { Bindings } from "../env";
import { checkRunStatement } from "../checks";
import { repoClient, type RepoClient } from "../git";
import { log } from "../log";
import { pullStatements } from "../pulls";
import { PermanentError, registerHandler, type JobHandler } from "./queue";

export const SYNC_KIND = "sync";

interface RepoRow {
  id: string;
  full_name: string;
}

/**
 * Copy the check runs of a commit. Never fails the sync: the host may not let
 * us read them, and webhooks keep them current anyway.
 */
async function syncChecks(env: Bindings, client: RepoClient, repo: RepoRow, sha: string): Promise<void> {
  try {
    const runs = await client.checkRuns(sha);
    if (runs === null) {
      log("warn", "sync could not read check runs", { repo: repo.full_name, sha }, env.LOG_FORMAT);
      return;
    }
    if (runs.length > 0) await env.DB.batch(runs.map((r) => checkRunStatement(env, repo.id, { ...r, head_sha: sha })));
  } catch (error) {
    log("warn", "sync could not read check runs", { repo: repo.full_name, sha, error: String(error) }, env.LOG_FORMAT);
  }
}

async function syncRepo(env: Bindings, projectId: string, repo: RepoRow, progress: (n: number) => Promise<void>): Promise<number> {
  const client = await repoClient(env, projectId, repo.full_name, "sync");
  const pulls = await client.openPulls();
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
    const files = before?.files_sha === pr.head.sha ? null : await client.pullFiles(pr.number);
    // One batch is one transaction: a PR never shows half its files.
    await env.DB.batch(pullStatements(env, repo.id, before?.id ?? crypto.randomUUID(), pr, files));
    await syncChecks(env, client, repo, pr.head.sha);
    await progress(pr.number);
  }

  // Recently closed PRs, so merged ones show up even if we never saw them open. The list carries
  // `merged_at`; files are not read for these.
  const closed = await client.recentlyClosedPulls();
  for (const pr of closed) {
    await env.DB.batch(pullStatements(env, repo.id, known.get(pr.number)?.id ?? crypto.randomUUID(), pr, null));
  }

  // Anything stored as open that the host no longer lists was merged or closed;
  // ask which, so the inbox can tell "Merged" from closed.
  const open = new Set(pulls.map((p) => p.number));
  const closedNow = new Set(closed.map((p) => p.number));
  const gone = [...known.keys()].filter((n) => !open.has(n) && !closedNow.has(n));
  for (const n of gone) {
    const mergedAt = (await client.pull(n))?.merged_at ?? null;
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
  const target = job.target.trim();
  const { results: repos } = target
    ? await ctx.env.DB.prepare("SELECT id, full_name FROM project_repos WHERE project_id = ?1 AND full_name = ?2 COLLATE NOCASE").bind(job.project_id, target).all<RepoRow>()
    : await ctx.env.DB.prepare("SELECT id, full_name FROM project_repos WHERE project_id = ?1 ORDER BY full_name").bind(job.project_id).all<RepoRow>();
  if (target && repos.length === 0) throw new PermanentError(`${target} is not a repository of this project`);

  let total = 0;
  for (const repo of repos) {
    const count = await syncRepo(ctx.env, job.project_id, repo, (number) => ctx.progress({ repo: repo.full_name, pr: number }));
    total += count;
    await ctx.progress({ repo: repo.full_name, openPullRequests: count });
  }
  await ctx.progress({ repos: repos.length, openPullRequests: total });
};

registerHandler(SYNC_KIND, syncHandler);
