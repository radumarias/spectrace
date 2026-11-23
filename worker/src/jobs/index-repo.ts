// Index job (T1.6, specs and anchors since T4.4): read a repository through the
// GitHub API, with no clone, and record what is there: repo details, and the
// specs, requirements and anchors parsed from one archive of the default branch.
// One job per repo; `target` is the `project_repos.id`. Re-running it is safe:
// it only overwrites the same rows.
import { publishSpecs } from "../devpage";
import type { Bindings } from "../env";
import { AppError } from "../error";
import { appConfigFromEnv, appJwt, ghHeaders, installationToken, linkRepoInstallation, type AppConfig } from "../github-app";
import { log } from "../log";
import type { RepoIndex } from "../specs";
import { readTarGz } from "../tarball";
import { enqueueJob, errorMessage, isFinalFailure, PermanentError, type JobContext, type JobRow } from "./queue";
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

const STEPS = 5;

/** What the index keeps of the repository archive (T4.4). */
const TAR_LIMITS = { maxFileBytes: 512 * 1024, maxTotalBytes: 48 * 1024 * 1024 };
/** Bound parameters per anchor row; D1 allows 100 per statement. */
const ANCHOR_COLS = 10;
const ANCHORS_PER_INSERT = Math.floor(100 / ANCHOR_COLS);
const MAX_ANCHORS = 5000;

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
  if (allowed) return id;
  // Installed on GitHub but never linked to this person (for example, installed outside spectrace's install page).
  if ((await linkRepoInstallation(app, env.DB, repo.owner_id, repo.full_name)) === id) return id;
  throw notInstalled;
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

  let index: RepoIndex = { specs: [], anchors: [] };
  let archiveTruncated = false;
  if (sha) {
    await ctx.progress({ ...base, step: 3, stage: "Reading specs, code and tests" });
    const tar = await ghGet(app, token, `/repos/${repo.full_name}/tarball/${encodeURIComponent(info.default_branch)}`);
    if (!tar.ok || !tar.body) throw failure("tarball", tar);
    // Loaded here, not at the top: the WASM core is only needed by the job, and
    // the routes (and `npm run openapi`, which runs them in Node) stay free of it.
    const { buildIndex, wantedPath } = await import("../specs");
    const read = await readTarGz(tar.body, wantedPath, TAR_LIMITS);
    archiveTruncated = read.truncated;
    await ctx.progress({ ...base, step: 4, stage: "Parsing specs and anchors" });
    index = buildIndex(read.files);
  }

  await ctx.progress({ ...base, step: 5, stage: "Reading languages" });
  const langRes = await ghGet(app, token, `/repos/${repo.full_name}/languages`);
  if (!langRes.ok) throw failure("languages", langRes);
  const languages = (await langRes.json()) as Record<string, number>;

  await storeIndex(env, repo, sha, index);
  await env.DB.prepare(
    `UPDATE project_repos SET github_repo_id = ?2, default_branch = ?3, languages = ?4, file_count = ?5,
       tree_truncated = ?6, head_sha = ?7, index_state = 'ready', index_error = NULL,
       indexed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?1`,
  )
    .bind(repo.id, info.id, info.default_branch, JSON.stringify(languages), fileCount, truncated || archiveTruncated ? 1 : 0, sha)
    .run();
  // devpage renders each spec; a spec it refuses keeps its last version, and the index stands.
  const devpage = await publishSpecs(env, repo.id, "spectrace");
  log(
    "info",
    "repo indexed",
    { jobId: job.id, repo: repo.full_name, files: fileCount, specs: index.specs.length, anchors: index.anchors.length, devpage },
    env.LOG_FORMAT,
  );
}

/** Replaces the repo's specs, edges and anchors in one transaction. A spec keeps its id while its path stays. */
async function storeIndex(env: Bindings, repo: RepoRow, sha: string | null, index: RepoIndex): Promise<void> {
  const { results: existing } = await env.DB.prepare("SELECT id, path FROM specs WHERE repo_id = ?1").bind(repo.id).all<{ id: string; path: string }>();
  const idOf = new Map(existing.map((r) => [r.path, r.id]));
  const keep = new Map(index.specs.map((s) => [s.path, idOf.get(s.path) ?? crypto.randomUUID()]));
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM anchors WHERE repo_id = ?1").bind(repo.id),
    env.DB.prepare("DELETE FROM spec_edges WHERE spec_id IN (SELECT id FROM specs WHERE repo_id = ?1)").bind(repo.id),
  ];
  for (const r of existing) if (!keep.has(r.path)) stmts.push(env.DB.prepare("DELETE FROM specs WHERE id = ?1").bind(r.id));
  for (const s of index.specs) {
    const id = keep.get(s.path)!;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO specs (id, project_id, repo_id, path, root, area, flow, title, source, model, diagnostics, step_count, requirement_count, tested_count, sha, indexed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT (repo_id, path) DO UPDATE SET
           root = excluded.root, area = excluded.area, flow = excluded.flow, title = excluded.title, source = excluded.source,
           model = excluded.model, diagnostics = excluded.diagnostics, step_count = excluded.step_count,
           requirement_count = excluded.requirement_count, tested_count = excluded.tested_count, sha = excluded.sha, indexed_at = excluded.indexed_at`,
      ).bind(
        id, repo.project_id, repo.id, s.path, s.root, s.area, s.flow, s.title, s.source,
        s.model ? JSON.stringify(s.model) : null, JSON.stringify(s.diagnostics), s.stepCount, s.requirementCount, s.testedCount, sha,
      ),
    );
    for (const e of s.edges) {
      stmts.push(env.DB.prepare("INSERT OR IGNORE INTO spec_edges (spec_id, from_node, label, to_node) VALUES (?1, ?2, ?3, ?4)").bind(id, e.from, e.label, e.to));
    }
  }
  const anchors = index.anchors.slice(0, MAX_ANCHORS);
  for (let i = 0; i < anchors.length; i += ANCHORS_PER_INSERT) {
    const rows = anchors.slice(i, i + ANCHORS_PER_INSERT);
    const values = rows.map((_, j) => `(${Array.from({ length: ANCHOR_COLS }, (_, k) => `?${j * ANCHOR_COLS + k + 1}`).join(", ")})`).join(", ");
    const params = rows.flatMap((a) => [repo.id, a.specPath ? (keep.get(a.specPath) ?? null) : null, a.path, a.line, a.language, a.kind, a.class, a.target, a.note, a.excerpt]);
    stmts.push(env.DB.prepare(`INSERT INTO anchors (repo_id, spec_id, path, line, language, kind, class, target, note, excerpt) VALUES ${values}`).bind(...params));
  }
  await env.DB.batch(stmts);
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
    // Leave "indexing" while the queue will try again; show "failed" once it will not.
    if (isFinalFailure(job, error)) await markFailed(ctx.env, repo.id, errorMessage(error));
    throw error;
  }
}
