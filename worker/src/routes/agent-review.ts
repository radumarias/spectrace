// Agent review of a pull request (T3.4): start one, and read the latest.
// The work is the "review" job (src/jobs/review.ts); its progress reaches
// browsers as job events on the project's WebSocket.
import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv, Bindings } from "../env";
import { requireUser } from "../auth";
import { AppError, ErrorBody } from "../error";
import { enqueueJob } from "../jobs/queue";
import { REVIEW_KIND } from "../jobs/review";
import { NOW } from "../pulls";
import { requireProjectOwner } from "./projects";
import { ProjectParam, PullParam } from "./pulls";

const Finding = z
  .object({
    id: z.number().int(),
    severity: z.enum(["high", "medium", "low"]),
    path: z.string(),
    line: z.number().int().nullable(),
    title: z.string(),
    body: z.string(),
    suggestedFix: z.string(),
    spec: z.string().nullable().openapi({ description: "Path of the spec the finding breaks, when it names one." }),
  })
  .openapi("Finding");

const AgentReview = z
  .object({
    id: z.string(),
    pullId: z.string(),
    jobId: z.string().nullable(),
    headSha: z.string().openapi({ description: "The commit that was reviewed." }),
    state: z.enum(["queued", "running", "succeeded", "failed"]),
    stage: z.string().openapi({ description: "queued, reading, reviewing, refuting, done or failed." }),
    walkthrough: z.string().openapi({ description: "Markdown, set once the review succeeded." }),
    backend: z.enum(["claude-code", "user_key", "api"]).nullable().openapi({ description: "Which Claude ran it: the owner's subscription, the requester's own key, or the server's key." }),
    model: z.string().nullable(),
    error: z.string().nullable(),
    createdAt: z.string(),
    finishedAt: z.string().nullable(),
    findings: z.array(Finding).openapi({ description: "Findings a refuter confirmed, most severe first." }),
    dropped: z.number().int().openapi({ description: "Findings the refuters could not confirm, left out." }),
  })
  .openapi("AgentReview");

const errors = {
  401: { description: "Not signed in", content: { "application/json": { schema: ErrorBody } } },
  404: { description: "Not found", content: { "application/json": { schema: ErrorBody } } },
};

const params = z.object({ projectId: ProjectParam, pullId: PullParam });

const start = createRoute({
  method: "post",
  path: "/api/projects/{projectId}/pulls/{pullId}/agent-review",
  summary: "Start an agent review of the pull request's head commit (or get the one already under way)",
  request: { params },
  responses: {
    202: { description: "Queued or already running", content: { "application/json": { schema: z.object({ review: AgentReview }) } } },
    401: errors[401],
    404: errors[404],
    502: { description: "The queue is unavailable", content: { "application/json": { schema: ErrorBody } } },
  },
});

const latest = createRoute({
  method: "get",
  path: "/api/projects/{projectId}/pulls/{pullId}/agent-review",
  summary: "The latest agent review of the pull request",
  request: { params },
  responses: {
    200: { description: "The latest review, or null when there is none", content: { "application/json": { schema: z.object({ review: AgentReview.nullable() }) } } },
    401: errors[401],
    404: errors[404],
  },
});

interface ReviewRow {
  id: string;
  pull_request_id: string;
  job_id: string | null;
  head_sha: string;
  state: "queued" | "running" | "succeeded" | "failed";
  stage: string;
  walkthrough: string;
  backend: "claude-code" | "user_key" | "api" | null;
  model: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

interface FindingRow {
  id: number;
  severity: "high" | "medium" | "low";
  path: string;
  line: number | null;
  title: string;
  body: string;
  suggested_fix: string;
  spec: string | null;
  refuted: number;
}

const RANK = { high: 0, medium: 1, low: 2 } as const;

async function toReview(env: Bindings, r: ReviewRow): Promise<z.infer<typeof AgentReview>> {
  // Findings are stored together with the success, so only a finished review has any.
  const { results } = r.state !== "succeeded" ? { results: [] as FindingRow[] } : await env.DB.prepare("SELECT id, severity, path, line, title, body, suggested_fix, spec, refuted FROM findings WHERE review_id = ?1 ORDER BY id").bind(r.id).all<FindingRow>();
  const kept = results.filter((f) => f.refuted === 0).sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.id - b.id);
  return {
    id: r.id,
    pullId: r.pull_request_id,
    jobId: r.job_id,
    headSha: r.head_sha,
    state: r.state,
    stage: r.stage,
    walkthrough: r.walkthrough,
    backend: r.backend,
    model: r.model,
    error: r.error,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
    findings: kept.map((f) => ({ id: f.id, severity: f.severity, path: f.path, line: f.line, title: f.title, body: f.body, suggestedFix: f.suggested_fix, spec: f.spec })),
    dropped: results.length - kept.length,
  };
}

async function pullOf(db: D1Database, projectId: string, pullId: string) {
  const row = await db
    .prepare("SELECT p.id, p.head_sha FROM pull_requests p JOIN project_repos r ON r.id = p.repo_id WHERE r.project_id = ?1 AND p.id = ?2")
    .bind(projectId, pullId)
    .first<{ id: string; head_sha: string }>();
  if (!row) throw AppError.notFound(`pull request ${pullId}`);
  return row;
}

export function registerAgentReview(app: OpenAPIHono<AppEnv>) {
  app.openapi(start, async (c) => {
    const { projectId, pullId } = c.req.valid("param");
    const user = await requireUser(c);
    await requireProjectOwner(c.env.DB, user.id, projectId);
    const pr = await pullOf(c.env.DB, projectId, pullId);

    // A review of this commit whose job is still under way covers the request. Its job reports
    // progress at every stage, so one silent for 10 minutes is stale (the same rule as a sync).
    const running = await c.env.DB.prepare(
      `SELECT r.* FROM reviews r JOIN jobs j ON j.id = r.job_id
        WHERE r.pull_request_id = ?1 AND r.head_sha = ?2 AND j.state IN ('queued', 'running')
          AND j.updated_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 minutes') ORDER BY r.created_at DESC LIMIT 1`,
    )
      .bind(pr.id, pr.head_sha)
      .first<ReviewRow>();
    if (running) return c.json({ review: await toReview(c.env, running) }, 202);

    const id = crypto.randomUUID();
    await c.env.DB.prepare("INSERT INTO reviews (id, pull_request_id, requested_by, head_sha) VALUES (?1, ?2, ?3, ?4)").bind(id, pr.id, user.id, pr.head_sha).run();
    let jobId: string;
    try {
      jobId = (await enqueueJob(c.env, projectId, REVIEW_KIND, id, 2)).id;
    } catch (error) {
      await c.env.DB.prepare(`UPDATE reviews SET state = 'failed', stage = 'failed', error = 'could not be queued', finished_at = ${NOW} WHERE id = ?1`).bind(id).run();
      throw error;
    }
    const row = await c.env.DB.prepare("UPDATE reviews SET job_id = ?2 WHERE id = ?1 RETURNING *").bind(id, jobId).first<ReviewRow>();
    if (!row) throw new AppError("internal", "review vanished after insert");
    return c.json({ review: await toReview(c.env, row) }, 202);
  });

  app.openapi(latest, async (c) => {
    const { projectId, pullId } = c.req.valid("param");
    await requireProjectOwner(c.env.DB, (await requireUser(c)).id, projectId);
    const pr = await pullOf(c.env.DB, projectId, pullId);
    const row = await c.env.DB.prepare("SELECT * FROM reviews WHERE pull_request_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1").bind(pr.id).first<ReviewRow>();
    return c.json({ review: row ? await toReview(c.env, row) : null }, 200);
  });
}
