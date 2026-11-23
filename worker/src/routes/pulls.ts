import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv, Bindings } from "../env";
import { requireUser } from "../auth";
import { AppError, ErrorBody } from "../error";
import { appConfigFromEnv, ghHeaders, installationToken } from "../github-app";
import { checkRunsOf, checksState } from "../checks";
import { pullGates } from "../gates";
import { enqueueJob, type JobRow } from "../jobs/queue";
import { installationFor, SYNC_KIND } from "../jobs/sync";
import { Job, toJob } from "./jobs";
import { requireProjectOwner } from "./projects";

const ProjectParam = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).openapi({ param: { name: "projectId", in: "path" } });
const PullParam = z.string().regex(/^[A-Za-z0-9-]{1,64}$/).openapi({ param: { name: "pullId", in: "path" } });

const Pull = z
  .object({
    id: z.string(),
    repo: z.string().openapi({ example: "acme/shop" }),
    number: z.number().int(),
    title: z.string(),
    author: z.string(),
    state: z.enum(["open", "merged", "closed"]),
    draft: z.boolean(),
    needsYou: z.boolean().openapi({ description: "Open, not a draft, and not yet handled by you." }),
    headRef: z.string(),
    baseRef: z.string(),
    htmlUrl: z.string(),
    additions: z.number().int(),
    deletions: z.number().int(),
    changedFiles: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
    mergedAt: z.string().nullable(),
    syncedAt: z.string(),
    testsTotal: z.number().int().openapi({ description: "Check runs of the head commit (a re-run replaces the earlier run of the same name)." }),
    testsPassed: z.number().int().openapi({ description: "Of those, completed with success, neutral or skipped." }),
    testsFailed: z.number().int().openapi({ description: "Of those, completed with any other conclusion." }),
  })
  .openapi("Pull");

const PullFile = z
  .object({
    path: z.string(),
    status: z.string(),
    previousPath: z.string().nullable(),
    additions: z.number().int(),
    deletions: z.number().int(),
  })
  .openapi("PullFile");

const CheckRun = z
  .object({
    name: z.string(),
    status: z.enum(["queued", "in_progress", "completed"]),
    conclusion: z.string().nullable().openapi({ description: "GitHub's: success, failure, neutral, cancelled, skipped, timed_out, action_required, stale; null until completed." }),
    url: z.string(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
  })
  .openapi("CheckRun");

const PullGate = z
  .object({
    id: z.enum(["review", "findings", "mapping", "tests", "approval"]),
    label: z.string(),
    status: z.enum(["pass", "open", "unchecked"]).openapi({ description: "`open` holds the merge back; `unchecked` is not known yet and does not." }),
  })
  .openapi("PullGate");

const PullDetail = Pull.extend({
  gates: z.array(PullGate).openapi({ description: "Merge gates, from the core rules. The merge call refuses while one is open." }),
  body: z.string(),
  headSha: z.string(),
  files: z.array(PullFile),
  checks: z.array(CheckRun).openapi({ description: "CI check runs of the head commit, failures first." }),
  checksState: z.enum(["none", "pending", "passing", "failing"]).openapi({ description: "`none` when no check run is stored (not synced, or the repo has no CI)." }),
}).openapi("PullDetail");

const PullDiff = z
  .object({
    files: z.array(z.object({ path: z.string(), patch: z.string().nullable().openapi({ description: "GitHub's unified diff; null for binary files and diffs that are too large." }) })),
  })
  .openapi("PullDiff");

const Counts = z
  .object({ needs: z.number().int(), open: z.number().int(), merged: z.number().int() })
  .openapi("PullCounts", { description: "Size of each inbox tab, over every repo of the project." });

const errors = {
  401: { description: "Not signed in", content: { "application/json": { schema: ErrorBody } } },
  400: { description: "Invalid request", content: { "application/json": { schema: ErrorBody } } },
  404: { description: "Not found", content: { "application/json": { schema: ErrorBody } } },
};

// One SQL expression per tab, so the list and the counts can never disagree.
// "Needs you" is every open, non-draft PR except the ones your latest review
// approved at the current head commit (a push brings them back). `?N` is the
// signed-in user's id; each query binds it at its own position.
const needs = (user: number) =>
  `(p.state = 'open' AND p.draft = 0 AND COALESCE((SELECT v.verdict FROM pull_reviews v
      WHERE v.pull_request_id = p.id AND v.user_id = ?${user} AND v.head_sha = p.head_sha ORDER BY v.id DESC LIMIT 1), '') <> 'approved')`;
const OPEN = "p.state = 'open'";
const MERGED = "p.merged_at IS NOT NULL";
const where = (filter: "needs" | "open" | "merged" | "all", user: number) => ({ needs: needs(user), open: OPEN, merged: MERGED, all: "1" })[filter];

interface PullRow {
  id: string;
  repo_id: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  author_login: string;
  state: "open" | "closed";
  draft: number;
  head_ref: string;
  head_sha: string;
  base_ref: string;
  html_url: string;
  additions: number;
  deletions: number;
  changed_files: number;
  github_created_at: string;
  github_updated_at: string;
  merged_at: string | null;
  synced_at: string;
  needs: number;
  tests_total: number;
  tests_passed: number;
  tests_failed: number;
}

// The latest run of each check name on the head commit; `extra` narrows which of them are counted.
const runs = (extra: string) =>
  `(SELECT COUNT(*) FROM pr_check_runs c WHERE c.repo_id = p.repo_id AND c.head_sha = p.head_sha ${extra}
      AND c.github_check_run_id = (SELECT MAX(x.github_check_run_id) FROM pr_check_runs x WHERE x.repo_id = c.repo_id AND x.head_sha = c.head_sha AND x.name = c.name))`;
const PASSED = "AND c.status = 'completed' AND c.conclusion IN ('success', 'neutral', 'skipped')";
const FAILED = "AND c.status = 'completed' AND COALESCE(c.conclusion, '') NOT IN ('success', 'neutral', 'skipped')";

const select = (user: number) => `SELECT p.*, r.full_name AS repo, ${needs(user)} AS needs,
  ${runs("")} AS tests_total, ${runs(PASSED)} AS tests_passed, ${runs(FAILED)} AS tests_failed
  FROM pull_requests p JOIN project_repos r ON r.id = p.repo_id`;

function toPull(r: PullRow): z.infer<typeof Pull> {
  return {
    id: r.id,
    repo: r.repo,
    number: r.number,
    title: r.title,
    author: r.author_login,
    state: r.merged_at ? "merged" : r.state,
    draft: r.draft === 1,
    needsYou: r.needs === 1,
    headRef: r.head_ref,
    baseRef: r.base_ref,
    htmlUrl: r.html_url,
    additions: r.additions,
    deletions: r.deletions,
    changedFiles: r.changed_files,
    createdAt: r.github_created_at,
    updatedAt: r.github_updated_at,
    mergedAt: r.merged_at,
    syncedAt: r.synced_at,
    testsTotal: r.tests_total,
    testsPassed: r.tests_passed,
    testsFailed: r.tests_failed,
  };
}

const list = createRoute({
  method: "get",
  path: "/api/projects/{projectId}/pulls",
  summary: "The project's pull requests, for the inbox",
  description:
    "`filter` is the inbox tab: `needs` (open, not a draft, not yet handled by you), `open`, `merged`, or `all` (default). " +
    "`repo` (`owner/name`) narrows the list to one repo; `counts` always covers every repo. " +
    "Needs-you PRs come first, then the most recently updated.",
  request: {
    params: z.object({ projectId: ProjectParam }),
    query: z.object({
      filter: z.enum(["needs", "open", "merged", "all"]).default("all"),
      repo: z.string().min(1).max(200).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }),
  },
  responses: {
    200: { description: "Pull requests and tab counts", content: { "application/json": { schema: z.object({ pulls: z.array(Pull), counts: Counts }) } } },
    400: errors[400],
    401: errors[401],
    404: errors[404],
  },
});

const get = createRoute({
  method: "get",
  path: "/api/projects/{projectId}/pulls/{pullId}",
  summary: "One pull request: header, description and changed files",
  request: { params: z.object({ projectId: ProjectParam, pullId: PullParam }) },
  responses: { 200: { description: "The pull request", content: { "application/json": { schema: PullDetail } } }, 401: errors[401], 404: errors[404] },
});

const diff = createRoute({
  method: "get",
  path: "/api/projects/{projectId}/pulls/{pullId}/diff",
  summary: "The unified diff of each changed file",
  description: "Kept apart from the pull request so the page loads without it. Files are in the same order as `files` on the pull request.",
  request: { params: z.object({ projectId: ProjectParam, pullId: PullParam }) },
  responses: { 200: { description: "Diffs by file", content: { "application/json": { schema: PullDiff } } }, 401: errors[401], 404: errors[404] },
});

const pull = createRoute({
  method: "post",
  path: "/api/projects/{projectId}/pulls/sync",
  summary: "Pull from GitHub: queue a sync of the project's pull requests (owner only)",
  description:
    "Queues the same `sync` job as `POST /jobs`. Follow it with `GET /jobs/{id}` or the project's event socket. " +
    "If a sync for the same repos is already queued or running, that job is returned instead of a second one.",
  request: {
    params: z.object({ projectId: ProjectParam }),
    body: { required: false, content: { "application/json": { schema: z.object({ repo: z.string().min(1).max(200).optional() }) } } },
  },
  responses: {
    202: { description: "The sync job, queued or already in flight", content: { "application/json": { schema: Job } } },
    400: errors[400],
    401: errors[401],
    404: errors[404],
    502: { description: "The queue is unavailable", content: { "application/json": { schema: ErrorBody } } },
  },
});

const Review = z
  .object({
    id: z.number().int(),
    verdict: z.enum(["approved", "changes_requested"]),
    body: z.string(),
    headSha: z.string().openapi({ description: "The commit the review was left on." }),
    githubReviewId: z.number().int().nullable(),
    createdAt: z.string(),
  })
  .openapi("PullReview");

const conflict = { description: "Not open, a draft, or GitHub refused (not mergeable, or the head moved)", content: { "application/json": { schema: ErrorBody } } };
const upstream = { description: "GitHub could not be reached or refused the call", content: { "application/json": { schema: ErrorBody } } };

const reviews = createRoute({
  method: "get",
  path: "/api/projects/{projectId}/pulls/{pullId}/reviews",
  summary: "The reviews you left on a pull request from spectrace, newest first",
  request: { params: z.object({ projectId: ProjectParam, pullId: PullParam }) },
  responses: { 200: { description: "Your reviews", content: { "application/json": { schema: z.object({ reviews: z.array(Review) }) } } }, 401: errors[401], 404: errors[404] },
});

const review = createRoute({
  method: "post",
  path: "/api/projects/{projectId}/pulls/{pullId}/reviews",
  summary: "Approve a pull request or request changes (owner only)",
  description:
    "Leaves a review on GitHub as the App, on the PR's current head commit, and records it. " +
    "An approval takes the PR out of `needs` until its head moves. `request_changes` needs a `body`.",
  request: {
    params: z.object({ projectId: ProjectParam, pullId: PullParam }),
    body: {
      required: true,
      content: { "application/json": { schema: z.object({ verdict: z.enum(["approve", "request_changes"]), body: z.string().max(65_000).optional() }) } },
    },
  },
  responses: {
    201: { description: "The recorded review", content: { "application/json": { schema: Review } } },
    400: errors[400],
    401: errors[401],
    404: errors[404],
    409: conflict,
    502: upstream,
  },
});

const merge = createRoute({
  method: "post",
  path: "/api/projects/{projectId}/pulls/{pullId}/merge",
  summary: "Merge a pull request on GitHub (owner only)",
  description:
    "Merges the PR at the head commit spectrace last saw (`squash` unless `method` says otherwise). " +
    "GitHub refuses when the PR is not mergeable or its head has moved; that comes back as 409 and a sync will refresh it.",
  request: {
    params: z.object({ projectId: ProjectParam, pullId: PullParam }),
    body: { required: false, content: { "application/json": { schema: z.object({ method: z.enum(["merge", "squash", "rebase"]).default("squash") }) } } },
  },
  responses: {
    200: { description: "The merged pull request", content: { "application/json": { schema: Pull } } },
    400: errors[400],
    401: errors[401],
    404: errors[404],
    409: conflict,
    502: upstream,
  },
});

/** What a write needs to know about a stored PR, checked to belong to a project the user owns. */
async function writablePull(c: Context<AppEnv>, projectId: string, pullId: string) {
  const user = await requireUser(c);
  await requireProjectOwner(c.env.DB, user.id, projectId);
  const row = await c.env.DB.prepare(
    `SELECT p.id, p.repo_id, p.number, p.state, p.draft, p.head_sha, p.merged_at, r.full_name FROM pull_requests p JOIN project_repos r ON r.id = p.repo_id
      WHERE r.project_id = ?1 AND p.id = ?2`,
  )
    .bind(projectId, pullId)
    .first<{ id: string; repo_id: string; number: number; state: string; draft: number; head_sha: string; merged_at: string | null; full_name: string }>();
  if (!row) throw AppError.notFound(`pull request ${pullId}`);
  if (row.state !== "open" || row.merged_at) throw new AppError("conflict", "conflict: the pull request is not open");
  return { user, pr: row };
}

/** A call to GitHub as the App installed on the repo's owner. Returns the status and body; 5xx and network errors throw. */
export async function github(env: Bindings, projectId: string, fullName: string, method: string, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const installationId = await installationFor(env, projectId, fullName);
  if (installationId === null) throw new AppError("conflict", `conflict: no GitHub App installation for ${fullName}; install the app on its owner first`);
  const app = appConfigFromEnv(env);
  const token = await installationToken(app, installationId);
  if (token === null) throw new AppError("conflict", `conflict: GitHub no longer knows the installation for ${fullName}`);
  let res: Response;
  try {
    res = await fetch(`${app.apiUrl}${path}`, { method, headers: { ...ghHeaders(token), "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (cause) {
    throw new AppError("upstream", `GitHub ${method} ${path}: ${String(cause)}`, { cause });
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status >= 500 || res.status === 401 || res.status === 403 || res.status === 429) {
    throw new AppError("upstream", `GitHub ${method} ${path}: status ${res.status} ${String(json.message ?? "")}`);
  }
  return { status: res.status, json };
}

const message = (json: Record<string, unknown>) => (typeof json.message === "string" ? json.message : "GitHub refused");

interface ReviewRow {
  id: number;
  verdict: "approved" | "changes_requested";
  body: string;
  head_sha: string;
  github_review_id: number | null;
  created_at: string;
}

const toReview = (r: ReviewRow): z.infer<typeof Review> => ({ id: r.id, verdict: r.verdict, body: r.body, headSha: r.head_sha, githubReviewId: r.github_review_id, createdAt: r.created_at });

export function registerPullActions(app: OpenAPIHono<AppEnv>) {
  app.openapi(reviews, async (c) => {
    const { projectId, pullId } = c.req.valid("param");
    const user = await requireUser(c);
    await requireProjectOwner(c.env.DB, user.id, projectId);
    const found = await c.env.DB.prepare("SELECT p.id FROM pull_requests p JOIN project_repos r ON r.id = p.repo_id WHERE r.project_id = ?1 AND p.id = ?2").bind(projectId, pullId).first();
    if (!found) throw AppError.notFound(`pull request ${pullId}`);
    const { results } = await c.env.DB.prepare("SELECT id, verdict, body, head_sha, github_review_id, created_at FROM pull_reviews WHERE pull_request_id = ?1 AND user_id = ?2 ORDER BY id DESC")
      .bind(pullId, user.id)
      .all<ReviewRow>();
    return c.json({ reviews: results.map(toReview) }, 200);
  });

  app.openapi(review, async (c) => {
    const { projectId, pullId } = c.req.valid("param");
    const { verdict, body } = c.req.valid("json");
    const text = (body ?? "").trim();
    if (verdict === "request_changes" && text === "") throw AppError.badRequest("requesting changes needs a comment");
    const { user, pr } = await writablePull(c, projectId, pullId);
    const res = await github(c.env, projectId, pr.full_name, "POST", `/repos/${pr.full_name}/pulls/${pr.number}/reviews`, {
      commit_id: pr.head_sha,
      event: verdict === "approve" ? "APPROVE" : "REQUEST_CHANGES",
      ...(text ? { body: text } : {}),
    });
    if (res.status !== 200 && res.status !== 201) throw new AppError("conflict", `conflict: ${message(res.json)}`);
    const row = await c.env.DB.prepare(
      `INSERT INTO pull_reviews (pull_request_id, user_id, verdict, body, head_sha, github_review_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       RETURNING id, verdict, body, head_sha, github_review_id, created_at`,
    )
      .bind(pullId, user.id, verdict === "approve" ? "approved" : "changes_requested", text, pr.head_sha, typeof res.json.id === "number" ? res.json.id : null)
      .first<ReviewRow>();
    if (!row) throw new AppError("internal", "pull_reviews insert returned no row");
    return c.json(toReview(row), 201);
  });

  app.openapi(merge, async (c) => {
    const { projectId, pullId } = c.req.valid("param");
    const method = (c.req.valid("json") ?? {}).method ?? "squash";
    const { user, pr } = await writablePull(c, projectId, pullId);
    if (pr.draft === 1) throw new AppError("conflict", "conflict: a draft pull request cannot be merged");
    const open = (await pullGates(c.env, pr)).find((g) => g.status === "open");
    if (open) throw new AppError("conflict", `conflict: gate open: ${open.label}`);
    const res = await github(c.env, projectId, pr.full_name, "PUT", `/repos/${pr.full_name}/pulls/${pr.number}/merge`, { merge_method: method, sha: pr.head_sha });
    // 404: gone; 405: not mergeable (checks, conflicts, protection); 409: head moved; 422: method not allowed.
    if (res.status !== 200) throw new AppError(res.status === 404 ? "not_found" : "conflict", `${res.status === 404 ? "not found" : "conflict"}: ${message(res.json)}`);
    // The `pull_request` webhook will say the same; storing it now keeps the answer and the inbox right at once.
    await c.env.DB.prepare(
      `UPDATE pull_requests SET state = 'closed', merged_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), github_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         synced_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1`,
    )
      .bind(pullId)
      .run();
    const row = await c.env.DB.prepare(`${select(2)} WHERE p.id = ?1`).bind(pullId, user.id).first<PullRow>();
    if (!row) throw AppError.notFound(`pull request ${pullId}`);
    return c.json(toPull(row), 200);
  });
}

export function registerPulls(app: OpenAPIHono<AppEnv>) {
  // Registered before `get` so "sync" is never read as a pull id.
  app.openapi(pull, async (c) => {
    const { projectId } = c.req.valid("param");
    await requireProjectOwner(c.env.DB, (await requireUser(c)).id, projectId);
    const repo = (c.req.valid("json") ?? {}).repo;
    let target = "";
    if (repo) {
      const row = await c.env.DB.prepare("SELECT full_name FROM project_repos WHERE project_id = ?1 AND full_name = ?2 COLLATE NOCASE").bind(projectId, repo).first<{ full_name: string }>();
      if (!row) throw AppError.notFound(`repo ${repo}`);
      target = row.full_name;
    }
    // A sync that is already waiting or running covers this request (a stale one, over 10 minutes, does not).
    const inFlight = await c.env.DB.prepare(
      `SELECT * FROM jobs WHERE project_id = ?1 AND kind = ?2 AND target = ?3 AND state IN ('queued', 'running')
         AND updated_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 minutes') ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(projectId, SYNC_KIND, target)
      .first<JobRow>();
    if (inFlight) return c.json(toJob(inFlight), 202);
    return c.json(toJob(await enqueueJob(c.env, projectId, SYNC_KIND, target, 3)), 202);
  });

  app.openapi(list, async (c) => {
    const { projectId } = c.req.valid("param");
    const { filter, repo, limit } = c.req.valid("query");
    const user = await requireUser(c);
    await requireProjectOwner(c.env.DB, user.id, projectId);
    const [rows, counts] = await c.env.DB.batch([
      c.env.DB.prepare(
        `${select(4)} WHERE r.project_id = ?1 AND (?2 IS NULL OR r.full_name = ?2 COLLATE NOCASE) AND ${where(filter, 4)}
         ORDER BY needs DESC, p.github_updated_at DESC, p.id LIMIT ?3`,
      ).bind(projectId, repo ?? null, limit, user.id),
      c.env.DB.prepare(
        `SELECT COALESCE(SUM(${needs(2)}), 0) AS needs, COALESCE(SUM(${OPEN}), 0) AS open, COALESCE(SUM(${MERGED}), 0) AS merged
           FROM pull_requests p JOIN project_repos r ON r.id = p.repo_id WHERE r.project_id = ?1`,
      ).bind(projectId, user.id),
    ]);
    return c.json({ pulls: (rows!.results as unknown as PullRow[]).map(toPull), counts: counts!.results[0] as z.infer<typeof Counts> }, 200);
  });

  app.openapi(diff, async (c) => {
    const { projectId, pullId } = c.req.valid("param");
    await requireProjectOwner(c.env.DB, (await requireUser(c)).id, projectId);
    const found = await c.env.DB.prepare("SELECT 1 AS x FROM pull_requests p JOIN project_repos r ON r.id = p.repo_id WHERE r.project_id = ?1 AND p.id = ?2").bind(projectId, pullId).first();
    if (!found) throw AppError.notFound(`pull request ${pullId}`);
    const { results } = await c.env.DB.prepare("SELECT path, patch FROM pr_files WHERE pull_request_id = ?1 ORDER BY path").bind(pullId).all<{ path: string; patch: string | null }>();
    return c.json({ files: results }, 200);
  });

  app.openapi(get, async (c) => {
    const { projectId, pullId } = c.req.valid("param");
    const user = await requireUser(c);
    await requireProjectOwner(c.env.DB, user.id, projectId);
    const row = await c.env.DB.prepare(`${select(3)} WHERE r.project_id = ?1 AND p.id = ?2`).bind(projectId, pullId, user.id).first<PullRow>();
    if (!row) throw AppError.notFound(`pull request ${pullId}`);
    const { results } = await c.env.DB.prepare("SELECT path, status, previous_path, additions, deletions FROM pr_files WHERE pull_request_id = ?1 ORDER BY path")
      .bind(pullId)
      .all<{ path: string; status: string; previous_path: string | null; additions: number; deletions: number }>();
    const files = results.map((f) => ({ path: f.path, status: f.status, previousPath: f.previous_path, additions: f.additions, deletions: f.deletions }));
    const checks = await checkRunsOf(c.env, row.repo_id, row.head_sha);
    const gates = await pullGates(c.env, { id: row.id, repo_id: row.repo_id, head_sha: row.head_sha });
    return c.json({ ...toPull(row), body: row.body, headSha: row.head_sha, files, checks, checksState: checksState(checks), gates }, 200);
  });
}
