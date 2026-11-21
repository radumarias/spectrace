import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../env";
import { requireUser } from "../auth";
import { AppError, ErrorBody } from "../error";
import { enqueueJob, type JobRow } from "../jobs/queue";
import { requireProjectOwner } from "./projects";

const ProjectParam = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).openapi({ param: { name: "projectId", in: "path" } });
const JobParam = z.string().regex(/^[A-Za-z0-9-]{1,64}$/).openapi({ param: { name: "jobId", in: "path" } });

const Job = z
  .object({
    id: z.string(),
    projectId: z.string(),
    kind: z.string(),
    target: z.string(),
    state: z.enum(["queued", "running", "succeeded", "failed"]),
    attempts: z.number().int(),
    maxAttempts: z.number().int(),
    error: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    finishedAt: z.string().nullable(),
  })
  .openapi("Job");

function toJob(r: JobRow): z.infer<typeof Job> {
  return {
    id: r.id,
    projectId: r.project_id,
    kind: r.kind,
    target: r.target,
    state: r.state,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at,
  };
}

const errors = {
  401: { description: "Not signed in", content: { "application/json": { schema: ErrorBody } } },
  400: { description: "Invalid request", content: { "application/json": { schema: ErrorBody } } },
  404: { description: "Not found", content: { "application/json": { schema: ErrorBody } } },
};

const enqueue = createRoute({
  method: "post",
  path: "/api/projects/{projectId}/jobs",
  summary: "Queue a job for a project (owner only)",
  request: {
    params: z.object({ projectId: ProjectParam }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            kind: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
            target: z.string().max(512).default(""),
            maxAttempts: z.number().int().min(1).max(10).default(3),
          }),
        },
      },
    },
  },
  responses: {
    202: { description: "Queued", content: { "application/json": { schema: Job } } },
    400: errors[400],
    401: errors[401],
    404: errors[404],
    502: { description: "The queue is unavailable", content: { "application/json": { schema: ErrorBody } } },
  },
});

const list = createRoute({
  method: "get",
  path: "/api/projects/{projectId}/jobs",
  summary: "The project's 50 most recent jobs",
  request: { params: z.object({ projectId: ProjectParam }) },
  responses: {
    200: { description: "Jobs, newest first", content: { "application/json": { schema: z.object({ jobs: z.array(Job) }) } } },
    401: errors[401],
    404: errors[404],
  },
});

const get = createRoute({
  method: "get",
  path: "/api/projects/{projectId}/jobs/{jobId}",
  summary: "One job",
  request: { params: z.object({ projectId: ProjectParam, jobId: JobParam }) },
  responses: { 200: { description: "The job", content: { "application/json": { schema: Job } } }, 401: errors[401], 404: errors[404] },
});

const events = createRoute({
  method: "get",
  path: "/api/projects/{projectId}/events",
  summary: "WebSocket: live job events for a project",
  description:
    "Upgrade to a WebSocket. Each text frame is one JSON event `{id, projectId, jobId, event, data, createdAt}`. " +
    "Pass `after=<last event id>` to replay what was missed; without it, only new events are sent.",
  request: { params: z.object({ projectId: ProjectParam }), query: z.object({ after: z.coerce.number().int().min(0).optional() }) },
  responses: { 101: { description: "Switching protocols" }, 400: errors[400], 401: errors[401], 404: errors[404] },
});

export function registerJobs(app: OpenAPIHono<AppEnv>) {
  app.openapi(enqueue, async (c) => {
    const { projectId } = c.req.valid("param");
    await requireProjectOwner(c.env.DB, (await requireUser(c)).id, projectId);
    const body = c.req.valid("json");
    const row = await enqueueJob(c.env, projectId, body.kind, body.target, body.maxAttempts);
    return c.json(toJob(row), 202);
  });

  app.openapi(list, async (c) => {
    const { projectId } = c.req.valid("param");
    await requireProjectOwner(c.env.DB, (await requireUser(c)).id, projectId);
    const { results } = await c.env.DB.prepare("SELECT * FROM jobs WHERE project_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 50").bind(projectId).all<JobRow>();
    return c.json({ jobs: results.map(toJob) }, 200);
  });

  app.openapi(get, async (c) => {
    const { projectId, jobId } = c.req.valid("param");
    await requireProjectOwner(c.env.DB, (await requireUser(c)).id, projectId);
    const row = await c.env.DB.prepare("SELECT * FROM jobs WHERE id = ?1 AND project_id = ?2").bind(jobId, projectId).first<JobRow>();
    if (!row) throw AppError.notFound(`job ${jobId}`);
    return c.json(toJob(row), 200);
  });

  app.openapi(events, async (c) => {
    const { projectId } = c.req.valid("param");
    const { after } = c.req.valid("query");
    await requireProjectOwner(c.env.DB, (await requireUser(c)).id, projectId);
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") throw AppError.badRequest("expected a WebSocket upgrade");
    const url = new URL(`http://hub/${encodeURIComponent(projectId)}`);
    if (after !== undefined) url.searchParams.set("after", String(after));
    return c.env.PROJECT_HUB.getByName(projectId).fetch(new Request(url, c.req.raw)) as unknown as Response;
  });
}
