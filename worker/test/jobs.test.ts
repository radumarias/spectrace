import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { hashToken } from "../src/auth";
import { backoffSeconds, JOBS_DLQ, JOBS_QUEUE, PermanentError, registerHandler, unregisterHandler, type JobMessage } from "../src/jobs/queue";

/** Session cookie of each project's owner, found by the project id in the path. */
const owners = new Map<string, string>();

const call = (path: string, init: RequestInit & { cookie?: string | null } = {}) => {
  const { cookie, ...rest } = init;
  const headers = new Headers(rest.headers);
  const project = /\/api\/projects\/([^/?]+)/.exec(path)?.[1] ?? "";
  const c = cookie === undefined ? owners.get(project) : cookie;
  if (c) headers.set("cookie", c);
  return exports.default.fetch(new Request(`http://spectrace.test${path}`, { ...rest, headers }));
};
const post = (path: string, body: unknown, cookie?: string | null) =>
  call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cookie });

let n = 0;

/** A signed-in user with a project of their own; `call` and `post` use their cookie for that project. */
async function newUser(): Promise<string> {
  const login = `user-${++n}-${crypto.randomUUID().slice(0, 8)}`;
  const userId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO users (id, github_id, login) VALUES (?1, ?2, ?3)").bind(userId, 1_000_000 + n, login).run();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(crypto.randomUUID(), userId, await hashToken(login), new Date(Date.now() + 86_400_000).toISOString())
    .run();
  return userId + "|" + `spectrace_session=${login}`;
}
async function newProject(): Promise<string> {
  const [userId, cookie] = (await newUser()).split("|") as [string, string];
  const id = `proj-${++n}-${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare("INSERT INTO projects (id, owner_id, name) VALUES (?1, ?2, 'p')").bind(id, userId).run();
  owners.set(id, cookie);
  return id;
}

/** Insert a job directly (no queue send), so tests drive delivery themselves. */
async function seed(projectId: string, kind: string, maxAttempts = 3) {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO jobs (id, project_id, kind, max_attempts) VALUES (?1, ?2, ?3, ?4)").bind(id, projectId, kind, maxAttempts).run();
  return id;
}

/** Deliver messages to the Worker's queue handler, as the Queues runtime would. */
async function deliver(queue: string, ...jobIds: string[]) {
  const batch = createMessageBatch<JobMessage>(queue, jobIds.map((jobId, i) => ({ id: `m${i}-${crypto.randomUUID()}`, timestamp: Date.now(), attempts: 1, body: { jobId } })));
  const ctx = createExecutionContext();
  await worker.queue(batch, env);
  const result = await getQueueResult(batch, ctx);
  return { ...result, ids: batch.messages.map((m) => m.id) };
}

const job = (id: string) => env.DB.prepare("SELECT * FROM jobs WHERE id = ?1").bind(id).first<{ state: string; attempts: number; error: string | null; finished_at: string | null }>();
const events = async (jobId: string) =>
  (await env.DB.prepare("SELECT event FROM job_events WHERE job_id = ?1 ORDER BY id").bind(jobId).all<{ event: string }>()).results.map((r) => r.event);

const registered: string[] = [];
function handler(kind: string, fn: Parameters<typeof registerHandler>[1]) {
  registerHandler(kind, fn);
  registered.push(kind);
}
afterEach(() => registered.splice(0).forEach(unregisterHandler));

describe("job delivery", () => {
  it("runs the effect once when a message is delivered twice and one attempt fails", async () => {
    await env.DB.exec("CREATE TABLE IF NOT EXISTS effects (job_id TEXT PRIMARY KEY, n INTEGER NOT NULL)");
    let calls = 0;
    handler("test.effect", async (j, ctx) => {
      calls++;
      if (calls === 1) throw new Error("flaky");
      await ctx.progress({ step: "writing" });
      // Idempotent by job id: a second run for the same job changes nothing.
      await ctx.env.DB.prepare("INSERT OR IGNORE INTO effects (job_id, n) VALUES (?1, 1)").bind(j.id).run();
    });
    const id = await seed(await newProject(), "test.effect");

    const first = await deliver(JOBS_QUEUE, id); // attempt 1 fails
    expect(first.retryMessages).toHaveLength(1);
    expect(await job(id)).toMatchObject({ state: "queued", attempts: 1, error: "flaky" });

    const second = await deliver(JOBS_QUEUE, id, id); // the retry, delivered twice at once
    expect(second.explicitAcks).toHaveLength(2);
    expect(await job(id)).toMatchObject({ state: "succeeded", attempts: 2, error: null });

    const third = await deliver(JOBS_QUEUE, id); // a late duplicate
    expect(third.explicitAcks).toHaveLength(1);

    const count = await env.DB.prepare("SELECT COUNT(*) AS c, SUM(n) AS s FROM effects WHERE job_id = ?1").bind(id).first<{ c: number; s: number }>();
    expect(count).toEqual({ c: 1, s: 1 });
    expect(calls).toBe(2); // one failure, one success; duplicates never reached the handler
    expect(await events(id)).toEqual(["started", "retrying", "started", "progress", "succeeded"]);
  });

  it("fails the job after max attempts, with back-off between tries", async () => {
    handler("test.broken", async () => {
      throw new Error("always");
    });
    const id = await seed(await newProject(), "test.broken", 3);
    for (let i = 0; i < 2; i++) expect((await deliver(JOBS_QUEUE, id)).retryMessages).toHaveLength(1);
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(backoffSeconds)).toEqual([5, 10, 20, 40, 80, 160, 300, 300]);
    const last = await deliver(JOBS_QUEUE, id);
    expect(last.explicitAcks).toHaveLength(1);
    expect(await job(id)).toMatchObject({ state: "failed", attempts: 3, error: "always" });
    expect((await job(id))?.finished_at).toBeTruthy();
    expect((await events(id)).slice(-1)).toEqual(["failed"]);
  });

  it("fails at once, without retrying, when there is no handler or the handler says so", async () => {
    const none = await seed(await newProject(), "test.unknown");
    expect((await deliver(JOBS_QUEUE, none)).retryMessages).toHaveLength(0);
    expect(await job(none)).toMatchObject({ state: "failed", attempts: 1, error: 'no handler for kind "test.unknown"' });

    handler("test.perm", async () => {
      throw new PermanentError("bad input");
    });
    const perm = await seed(await newProject(), "test.perm");
    expect((await deliver(JOBS_QUEUE, perm)).retryMessages).toHaveLength(0);
    expect(await job(perm)).toMatchObject({ state: "failed", error: "bad input" });
  });

  it("leaves a job that another delivery is running alone and asks to be retried later", async () => {
    handler("test.never", async () => undefined);
    const id = await seed(await newProject(), "test.never");
    await env.DB.prepare("UPDATE jobs SET state = 'running', attempts = 1 WHERE id = ?1").bind(id).run();
    const res = await deliver(JOBS_QUEUE, id);
    expect(res.retryMessages).toHaveLength(1);
    expect(res.explicitAcks).toHaveLength(0);
    expect(await job(id)).toMatchObject({ state: "running", attempts: 1 });
  });

  it("takes over a running job whose lease ran out", async () => {
    handler("test.takeover", async () => undefined);
    const id = await seed(await newProject(), "test.takeover");
    await env.DB.prepare("UPDATE jobs SET state = 'running', attempts = 1, updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?1").bind(id).run();
    await deliver(JOBS_QUEUE, id);
    expect(await job(id)).toMatchObject({ state: "succeeded", attempts: 2 });
  });

  it("acks messages for jobs that do not exist", async () => {
    const res = await deliver(JOBS_QUEUE, "no-such-job");
    expect(res.explicitAcks).toHaveLength(1);
  });

  it("marks a job failed when its message reaches the dead-letter queue", async () => {
    const id = await seed(await newProject(), "test.dead");
    const res = await deliver(JOBS_DLQ, id);
    expect(res.explicitAcks).toHaveLength(1);
    expect(await job(id)).toMatchObject({ state: "failed", error: "dead-lettered" });
    expect(await events(id)).toEqual(["failed"]);
  });
});

describe("jobs API", () => {
  it("queues a job, lists it and reads it back", async () => {
    const project = await newProject();
    const res = await post(`/api/projects/${project}/jobs`, { kind: "sync", target: "main" });
    expect(res.status).toBe(202);
    const created = (await res.json()) as { id: string; state: string; target: string; maxAttempts: number };
    expect(created).toMatchObject({ state: "queued", target: "main", maxAttempts: 3 });

    const listed = (await (await call(`/api/projects/${project}/jobs`)).json()) as { jobs: { id: string }[] };
    expect(listed.jobs.map((j) => j.id)).toEqual([created.id]);

    const one = await call(`/api/projects/${project}/jobs/${created.id}`);
    expect(one.status).toBe(200);
    expect((await one.json()) as object).toMatchObject({ id: created.id, projectId: project });
    expect(await events(created.id)).toContain("queued");
  });

  it("keeps projects apart and rejects bad input", async () => {
    const a = await newProject();
    const { id } = (await (await post(`/api/projects/${a}/jobs`, { kind: "index" })).json()) as { id: string };
    expect((await call(`/api/projects/${await newProject()}/jobs/${id}`)).status).toBe(404);
    expect(await (await call(`/api/projects/${await newProject()}/jobs`)).json()).toEqual({ jobs: [] });
    for (const body of [{ kind: "Not Valid" }, { kind: "sync", maxAttempts: 0 }, {}]) {
      const bad = await post(`/api/projects/${a}/jobs`, body);
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("bad_request");
    }
  });

  it("fails the job and returns 502 when the queue is down", async () => {
    const project = await newProject();
    const real = env.JOBS.send;
    env.JOBS.send = () => Promise.reject(new Error("queue down"));
    try {
      const res = await post(`/api/projects/${project}/jobs`, { kind: "sync" });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: { code: "upstream", message: "internal server error" } });
    } finally {
      env.JOBS.send = real;
    }
    const { jobs } = (await (await call(`/api/projects/${project}/jobs`)).json()) as { jobs: { state: string; error: string }[] };
    expect(jobs[0]).toMatchObject({ state: "failed", error: "could not be queued" });
  });
});

interface Frame {
  id: number;
  projectId: string;
  jobId: string;
  event: string;
  data: Record<string, unknown>;
}

async function connect(project: string, query = ""): Promise<{ ws: WebSocket; frames: Frame[]; waitFor: (n: number) => Promise<Frame[]> }> {
  const res = await call(`/api/projects/${project}/events${query}`, { headers: { upgrade: "websocket" } });
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error("no websocket");
  ws.accept();
  const frames: Frame[] = [];
  let wake: (() => void) | undefined;
  ws.addEventListener("message", (e) => {
    frames.push(JSON.parse(String(e.data)) as Frame);
    wake?.();
  });
  const waitFor = async (count: number) => {
    const deadline = Date.now() + 3000;
    while (frames.length < count && Date.now() < deadline) await new Promise<void>((r) => { wake = r; setTimeout(r, 50); });
    return frames;
  };
  return { ws, frames, waitFor };
}

describe("access", () => {
  it("needs sign-in on every job route", async () => {
    const project = await newProject();
    const id = await seed(project, "test.access");
    for (const [method, path] of [
      ["POST", `/api/projects/${project}/jobs`],
      ["GET", `/api/projects/${project}/jobs`],
      ["GET", `/api/projects/${project}/jobs/${id}`],
      ["GET", `/api/projects/${project}/events`],
    ] as const) {
      const res = await call(path, { method, headers: { "content-type": "application/json", upgrade: "websocket" }, body: method === "POST" ? '{"kind":"sync"}' : undefined, cookie: null });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("answers 404 for someone else's project, and for one that does not exist", async () => {
    const project = await newProject();
    const id = await seed(project, "test.access");
    const stranger = (await newUser()).split("|")[1];
    for (const [method, path] of [
      ["POST", `/api/projects/${project}/jobs`],
      ["GET", `/api/projects/${project}/jobs`],
      ["GET", `/api/projects/${project}/jobs/${id}`],
      ["GET", `/api/projects/${project}/events`],
      ["GET", `/api/projects/no-such-project/jobs`],
    ] as const) {
      const res = await call(path, { method, headers: { "content-type": "application/json", upgrade: "websocket" }, body: method === "POST" ? '{"kind":"sync"}' : undefined, cookie: stranger });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect((await job(id))?.state).toBe("queued");
  });

  it("removes a project's jobs and events with the project", async () => {
    handler("test.cascade", async () => undefined);
    const project = await newProject();
    const id = await seed(project, "test.cascade");
    await deliver(JOBS_QUEUE, id);
    expect(await events(id)).toHaveLength(2);
    await env.DB.prepare("DELETE FROM projects WHERE id = ?1").bind(project).run();
    expect(await job(id)).toBeNull();
    expect(await events(id)).toEqual([]);
  });
});

describe("project event stream", () => {
  it("shows a client the progress events of a project's jobs, and nobody else's", async () => {
    handler("test.stream", async (_j, ctx) => {
      await ctx.progress({ pct: 50 });
    });
    const project = await newProject();
    const other = await newProject();
    const { ws, waitFor } = await connect(project);
    const otherClient = await connect(other);

    const id = await seed(project, "test.stream");
    await deliver(JOBS_QUEUE, id);

    const got = await waitFor(3);
    expect(got.map((f) => f.event)).toEqual(["started", "progress", "succeeded"]);
    expect(got.every((f) => f.projectId === project && f.jobId === id)).toBe(true);
    expect(got[1]?.data).toEqual({ kind: "test.stream", pct: 50 }); // every event names its job kind;
    expect(got.map((f) => f.id)).toEqual([...got.map((f) => f.id)].sort((a, b) => a - b));
    expect(otherClient.frames).toHaveLength(0);
    ws.close();
    otherClient.ws.close();
  });

  it("streams the 'queued' event of a job queued through the API", async () => {
    const project = await newProject();
    const { ws, waitFor } = await connect(project);
    await post(`/api/projects/${project}/jobs`, { kind: "sync" });
    const got = await waitFor(1);
    expect(got[0]).toMatchObject({ event: "queued", projectId: project });
    ws.close();
  });

  it("replays events after a given id on reconnect, and nothing without one", async () => {
    handler("test.replay", async () => undefined);
    const project = await newProject();
    const id = await seed(project, "test.replay");
    await deliver(JOBS_QUEUE, id);
    const all = (await env.DB.prepare("SELECT id FROM job_events WHERE project_id = ?1 ORDER BY id").bind(project).all<{ id: number }>()).results;
    expect(all).toHaveLength(2);

    const fresh = await connect(project);
    await new Promise((r) => setTimeout(r, 100));
    expect(fresh.frames).toHaveLength(0);

    const resumed = await connect(project, `?after=${all[0]?.id}`);
    const got = await resumed.waitFor(1);
    expect(got.map((f) => f.event)).toEqual(["succeeded"]);

    const everything = await connect(project, "?after=0");
    expect((await everything.waitFor(2)).map((f) => f.event)).toEqual(["started", "succeeded"]);
    for (const c of [fresh, resumed, everything]) c.ws.close();
  });

  it("refuses a plain GET", async () => {
    const res = await call(`/api/projects/${await newProject()}/events`);
    expect(res.status).toBe(400);
  });
});
