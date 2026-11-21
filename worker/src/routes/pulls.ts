import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../env";
import { requireUser } from "../auth";
import { AppError, ErrorBody } from "../error";
import { enqueueJob, type JobRow } from "../jobs/queue";
import { SYNC_KIND } from "../jobs/sync";
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

const PullDetail = Pull.extend({ body: z.string(), headSha: z.string(), files: z.array(PullFile) }).openapi("PullDetail");

const Counts = z
  .object({ needs: z.number().int(), open: z.number().int(), merged: z.number().int() })
  .openapi("PullCounts", { description: "Size of each inbox tab, over every repo of the project." });

const errors = {
  401: { description: "Not signed in", content: { "application/json": { schema: ErrorBody } } },
  400: { description: "Invalid request", content: { "application/json": { schema: ErrorBody } } },
  404: { description: "Not found", content: { "application/json": { schema: ErrorBody } } },
};

// One SQL expression per tab, so the list and the counts can never disagree.
// "Needs you" is every open, non-draft PR for now; T2.6 adds approvals and will
// leave out the ones you already approved.
const NEEDS = "(p.state = 'open' AND p.draft = 0)";
const OPEN = "p.state = 'open'";
const MERGED = "p.merged_at IS NOT NULL";
const WHERE = { needs: NEEDS, open: OPEN, merged: MERGED, all: "1" } as const;

interface PullRow {
  id: string;
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
}

const SELECT = `SELECT p.*, r.full_name AS repo, ${NEEDS} AS needs
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
    await requireProjectOwner(c.env.DB, (await requireUser(c)).id, projectId);
    const [rows, counts] = await c.env.DB.batch([
      c.env.DB.prepare(
        `${SELECT} WHERE r.project_id = ?1 AND (?2 IS NULL OR r.full_name = ?2 COLLATE NOCASE) AND ${WHERE[filter]}
         ORDER BY needs DESC, p.github_updated_at DESC, p.id LIMIT ?3`,
      ).bind(projectId, repo ?? null, limit),
      c.env.DB.prepare(
        `SELECT COALESCE(SUM(${NEEDS}), 0) AS needs, COALESCE(SUM(${OPEN}), 0) AS open, COALESCE(SUM(${MERGED}), 0) AS merged
           FROM pull_requests p JOIN project_repos r ON r.id = p.repo_id WHERE r.project_id = ?1`,
      ).bind(projectId),
    ]);
    return c.json({ pulls: (rows!.results as unknown as PullRow[]).map(toPull), counts: counts!.results[0] as z.infer<typeof Counts> }, 200);
  });

  app.openapi(get, async (c) => {
    const { projectId, pullId } = c.req.valid("param");
    await requireProjectOwner(c.env.DB, (await requireUser(c)).id, projectId);
    const row = await c.env.DB.prepare(`${SELECT} WHERE r.project_id = ?1 AND p.id = ?2`).bind(projectId, pullId).first<PullRow>();
    if (!row) throw AppError.notFound(`pull request ${pullId}`);
    const { results } = await c.env.DB.prepare("SELECT path, status, previous_path, additions, deletions FROM pr_files WHERE pull_request_id = ?1 ORDER BY path")
      .bind(pullId)
      .all<{ path: string; status: string; previous_path: string | null; additions: number; deletions: number }>();
    const files = results.map((f) => ({ path: f.path, status: f.status, previousPath: f.previous_path, additions: f.additions, deletions: f.deletions }));
    return c.json({ ...toPull(row), body: row.body, headSha: row.head_sha, files }, 200);
  });
}
