// Index job, first version (T1.6): read a repository through the GitHub API,
// with no clone, and record what is there. One job per repo; `target` is the
// `project_repos.id`. Re-running it is safe: it only overwrites the same row.
import type { Bindings } from "../env";
import { AppError } from "../error";
import { appConfigFromEnv, appJwt, ghHeaders, installationToken, type AppConfig } from "../github-app";
import { log } from "../log";
import { enqueueJob, PermanentError, type JobContext, type JobRow } from "./queue";
import { SYNC_KIND } from "./sync";

export const INDEX_KIND = "index";

/** Queue an index job for one repo of a project. */
export const enqueueIndex = (env: Bindings, projectId: string, repoId: string) => enqueueJob(env, projectId, INDEX_KIND, repoId);

/**
 * Queue index jobs for repos, best effort. A queue that is down must not fail
 * the request that added the repo, so the repo is marked failed instead and
 * the person can re-index later.
 */
export async function enqueueIndexes(env: Bindings, projectId: string, repoIds: string[]): Promise<void> {
  for (const repoId of repoIds) {
    try {
      await enqueueIndex(env, projectId, repoId);
    } catch (error) {
      log("error", "could not queue index job", { projectId, repoId, error: String(error) }, env.LOG_FORMAT);
      await markFailed(env, repoId, "could not be queued");
    }
  }
  // Pull requests do not wait for the index: the first sync starts right away.
  if (repoIds.length > 0) {
    try {
      await enqueueJob(env, projectId, SYNC_KIND, "", 3);
    } catch (error) {
      log("error", "could not queue sync job", { projectId, error: String(error) }, env.LOG_FORMAT);
    }
  }
}

interface RepoRow {
  id: string;
  project_id: string;
  full_name: string;
  owner_id: string;
}

const STEPS = 3;

async function markFailed(env: Bindings, repoId: string, message: string) {
  await env.DB.prepare("UPDATE project_repos SET index_state = 'failed', index_error = ?2 WHERE id = ?1").bind(repoId, message.slice(0, 500)).run();
}

async function ghGet(app: AppConfig, token: string, path: string): Promise<Response> {
  try {
    return await fetch(`${app.apiUrl}${path}`, { headers: ghHeaders(token) });
  } catch (cause) {
    throw new Error(`GitHub ${path}: ${String(cause)}`, { cause });
  }
}

/** 4xx other than rate limits cannot be fixed by trying again; 5xx and rate limits can. */
function failure(what: string, res: Response): Error {
  const rateLimited = res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
  const msg = `GitHub ${what}: status ${res.status}`;
  return res.status >= 400 && res.status < 500 && !rateLimited ? new PermanentError(msg) : new Error(msg);
}

/** The installation of the GitHub App that covers this repo, and only if the project's owner may use it. */
async function installationFor(env: Bindings, app: AppConfig, repo: RepoRow): Promise<number> {
  const notInstalled = new PermanentError(`the spectrace GitHub App is not installed on ${repo.full_name}`);
  let res: Response;
  try {
    res = await fetch(`${app.apiUrl}/repos/${repo.full_name}/installation`, { headers: ghHeaders(await appJwt(app)) });
  } catch (cause) {
    if (cause instanceof AppError) throw new PermanentError(cause.message);
    throw new Error(`GitHub installation lookup: ${String(cause)}`, { cause });
  }
  if (res.status === 404) throw notInstalled;
  if (!res.ok) throw failure("installation lookup", res);
  const { id } = (await res.json()) as { id: number };
  const allowed = await env.DB.prepare("SELECT 1 AS ok FROM user_installations WHERE user_id = ?1 AND installation_id = ?2").bind(repo.owner_id, id).first();
  if (!allowed) throw notInstalled;
  return id;
}

async function readRepo(job: JobRow, ctx: JobContext, repo: RepoRow): Promise<void> {
  const { env } = ctx;
  let app: AppConfig;
  try {
    app = appConfigFromEnv(env);
  } catch (error) {
    throw new PermanentError(error instanceof Error ? error.message : String(error));
  }
  const installationId = await installationFor(env, app, repo);
  const token = await installationToken(app, installationId);
  if (!token) throw new PermanentError(`the spectrace GitHub App is no longer installed (${repo.full_name})`);
  const base = { repoId: repo.id, repo: repo.full_name, steps: STEPS };

  await ctx.progress({ ...base, step: 1, stage: "Reading repo details" });
  const meta = await ghGet(app, token, `/repos/${repo.full_name}`);
  if (!meta.ok) throw failure("repository", meta);
  const info = (await meta.json()) as { id: number; default_branch: string };

  await ctx.progress({ ...base, step: 2, stage: "Reading code, docs and tests" });
  const treeRes = await ghGet(app, token, `/repos/${repo.full_name}/git/trees/${encodeURIComponent(info.default_branch)}?recursive=1`);
  let fileCount = 0;
  let truncated = false;
  let sha: string | null = null;
  // 409 is GitHub's answer for a repository with no commits yet.
  if (treeRes.status !== 409) {
    if (!treeRes.ok) throw failure("git tree", treeRes);
    const tree = (await treeRes.json()) as { sha: string; truncated?: boolean; tree: { type: string }[] };
    fileCount = tree.tree.filter((e) => e.type === "blob").length;
    truncated = tree.truncated === true;
    sha = tree.sha;
  }

  await ctx.progress({ ...base, step: 3, stage: "Reading languages" });
  const langRes = await ghGet(app, token, `/repos/${repo.full_name}/languages`);
  if (!langRes.ok) throw failure("languages", langRes);
  const languages = (await langRes.json()) as Record<string, number>;

  await env.DB.prepare(
    `UPDATE project_repos SET github_repo_id = ?2, default_branch = ?3, languages = ?4, file_count = ?5,
       tree_truncated = ?6, head_sha = ?7, index_state = 'ready', index_error = NULL,
       indexed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?1`,
  )
    .bind(repo.id, info.id, info.default_branch, JSON.stringify(languages), fileCount, truncated ? 1 : 0, sha)
    .run();
  log("info", "repo indexed", { jobId: job.id, repo: repo.full_name, files: fileCount }, env.LOG_FORMAT);
}

/** The job handler for kind "index". */
export async function indexRepo(job: JobRow, ctx: JobContext): Promise<void> {
  const repo = await ctx.env.DB.prepare(
    `SELECT r.id, r.project_id, r.full_name, p.owner_id FROM project_repos r JOIN projects p ON p.id = r.project_id
     WHERE r.id = ?1 AND r.project_id = ?2`,
  )
    .bind(job.target, job.project_id)
    .first<RepoRow>();
  if (!repo) return; // removed since it was queued: nothing to index

  await ctx.env.DB.prepare("UPDATE project_repos SET index_state = 'indexing', index_error = NULL WHERE id = ?1").bind(repo.id).run();
  try {
    await readRepo(job, ctx, repo);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Leave "indexing" while the queue will try again; show "failed" once it will not.
    if (error instanceof PermanentError || job.attempts >= job.max_attempts) await markFailed(ctx.env, repo.id, message);
    throw error;
  }
}
