import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "../src/auth";
import { forgetInstallationTokens } from "../src/github-app";
import worker from "../src/index";
import { JOBS_QUEUE, type JobMessage } from "../src/jobs/queue";
import { SHOP } from "./fixtures";
import { tarGz } from "./tar";

const API = "http://api.github.test";

/** Recorded-style GitHub answers for the repos the tests use. */
const REPOS: Record<string, { installation: number; meta: object; tree: object | 409; languages: object; files?: Record<string, string> }> = {
  "acme/shop": {
    installation: 1001,
    meta: { id: 501, default_branch: "trunk", full_name: "acme/shop" },
    tree: { sha: "abc123", truncated: false, tree: [{ type: "tree" }, { type: "blob" }, { type: "blob" }, { type: "blob" }] },
    languages: { Rust: 9000, TypeScript: 1200 },
    files: SHOP,
  },
  "acme/empty": { installation: 1001, meta: { id: 502, default_branch: "main" }, tree: 409, languages: {} },
  "acme/big": {
    installation: 1001,
    meta: { id: 503, default_branch: "main" },
    tree: { sha: "def456", truncated: true, tree: [{ type: "blob" }] },
    languages: { Go: 5 },
  },
  "other/private": { installation: 2002, meta: { id: 504, default_branch: "main" }, tree: { sha: "x", tree: [] }, languages: {} },
};

const DEVPAGE = "http://devpage.test";

let calls: string[] = [];
/** What the fake devpage server was asked: method, path and query, the author header, and for a publish the zip's one file. */
let devpageCalls: { req: string; author: string | null; file?: { path: string; text: string } }[] = [];
let devpageDocs = new Map<string, number>();
let devpageRefuses = false;
/** Writes the GitHub mock took: method, path and JSON body. */
let ghWrites: { req: string; body: Record<string, unknown> }[] = [];

/** The one file of a stored zip (src/zip.ts). */
function unzipOne(bytes: Uint8Array): { path: string; text: string } {
  const v = new DataView(bytes.buffer, bytes.byteOffset);
  expect(v.getUint32(0, true)).toBe(0x04034b50);
  const size = v.getUint32(18, true);
  const nameLen = v.getUint16(26, true);
  const dec = new TextDecoder();
  return { path: dec.decode(bytes.subarray(30, 30 + nameLen)), text: dec.decode(bytes.subarray(30 + nameLen, 30 + nameLen + size)) };
}

/** devpage server's API and pages as far as spectrace uses them. */
async function fakeDevpage(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const call: (typeof devpageCalls)[number] = { req: `${req.method} ${url.pathname}${url.search}`, author: req.headers.get("x-spectrace-user") };
  devpageCalls.push(call);
  if (req.method === "POST") {
    call.file = unzipOne(new Uint8Array(await req.arrayBuffer()));
    if (devpageRefuses) return new Response("broken link: gone.md", { status: 422 });
    const add = /^\/api\/documents\/([^/]+)\/versions$/.exec(url.pathname);
    const id = add ? add[1]! : crypto.randomUUID();
    if (add && !devpageDocs.has(id)) return new Response("not found", { status: 404 });
    const version = (devpageDocs.get(id) ?? 0) + 1;
    devpageDocs.set(id, version);
    return Response.json({ id, version, url: `/d/${id}/` }, { status: 201 });
  }
  const page = /^\/d\/([^/]+)\//.exec(url.pathname);
  if (page && devpageDocs.has(page[1]!)) return new Response(`<h1>devpage ${page[1]} v${devpageDocs.get(page[1]!)}</h1>`, { headers: { "content-type": "text/html" } });
  if (url.pathname.startsWith("/__devpage/")) return new Response("/* asset */", { headers: { "content-type": "text/css" } });
  return new Response("not found", { status: 404 });
}
let tarballs: string[] = []; // refs whose archive was read
let flaky = 0; // how many times the languages call should answer 502 before working

function mockGithub() {
  const real = globalThis.fetch;
  calls = [];
  devpageCalls = [];
  devpageDocs = new Map();
  devpageRefuses = false;
  ghWrites = [];
  tarballs = [];
  flaky = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    if (url.origin === DEVPAGE) return fakeDevpage(req);
    if (url.origin !== API) return real(input, init);
    calls.push(`${req.method} ${url.pathname}`);
    const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
    if (mint) return Response.json({ token: `ghs_${mint[1]}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 });
    const inst = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(url.pathname);
    if (inst) {
      const r = REPOS[inst[1]!];
      return r ? Response.json({ id: r.installation }) : Response.json({}, { status: 404 });
    }
    const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(url.pathname);
    const r = m && REPOS[m[1]!];
    if (!r) return Response.json({}, { status: 404 });
    const bearer = (req.headers.get("authorization") ?? "").replace("Bearer ", "");
    if (bearer !== `ghs_${r.installation}`) return Response.json({}, { status: 401 });
    const rest = m[2] ?? "";
    if (rest === "") return Response.json(r.meta);
    if (rest.startsWith("/git/trees/")) {
      expect(url.searchParams.get("recursive")).toBe("1");
      return r.tree === 409 ? Response.json({ message: "Git Repository is empty." }, { status: 409 }) : Response.json(r.tree);
    }
    if (rest.startsWith("/tarball/")) {
      tarballs.push(decodeURIComponent(rest.slice("/tarball/".length)));
      return new Response(await tarGz(r.files ?? {}), { headers: { "content-type": "application/x-gzip" } });
    }
    if (rest.startsWith("/contents/") && req.method === "GET") {
      const file = r.files?.[decodeURIComponent(rest.slice("/contents/".length))];
      if (file === undefined) return Response.json({ message: "Not Found" }, { status: 404 });
      expect(url.searchParams.get("ref")).toBe((r.meta as { default_branch: string }).default_branch);
      return Response.json({ sha: "blob-1", encoding: "base64", content: btoa(String.fromCharCode(...new TextEncoder().encode(file))).replace(/(.{60})/g, "$1\n") });
    }
    if (rest.startsWith("/git/ref/heads/")) return Response.json({ ref: rest.slice(9), object: { sha: "base-sha" } });
    if (req.method !== "GET" && (rest === "/git/refs" || rest.startsWith("/contents/") || rest === "/pulls")) {
      const body = (await req.json()) as Record<string, unknown>;
      ghWrites.push({ req: `${req.method} ${rest}`, body });
      if (rest === "/pulls") return Response.json({ number: 7, html_url: `https://github.com/${m[1]}/pull/7` }, { status: 201 });
      return Response.json({}, { status: 201 });
    }
    if (rest === "/languages") {
      if (flaky > 0) {
        flaky--;
        return Response.json({}, { status: 502 });
      }
      return Response.json(r.languages);
    }
    return Response.json({}, { status: 404 });
  });
}

let n = 0;

/** A signed-in user who may use installation 1001, with a project holding the given repos. */
async function setup(repos: string[]) {
  const login = `user-${++n}-${crypto.randomUUID().slice(0, 8)}`;
  const userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, github_id, login) VALUES (?1, ?2, ?3)").bind(userId, 2_000_000 + n, login),
    env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?1, ?2, ?3, ?4)").bind(
      crypto.randomUUID(),
      userId,
      await hashToken(login),
      new Date(Date.now() + 86_400_000).toISOString(),
    ),
    env.DB.prepare("INSERT OR IGNORE INTO github_installations (id, account_id, account_login, account_type, repository_selection) VALUES (1001, 1, 'acme', 'Organization', 'all')"),
    env.DB.prepare("INSERT INTO user_installations (user_id, installation_id) VALUES (?1, 1001)").bind(userId),
  ]);
  const cookie = `spectrace_session=${login}`;
  const res = await post("/api/projects", cookie, { name: "Shop", repos: repos.map((full_name) => ({ full_name })) });
  expect(res.status).toBe(201);
  return { cookie, project: (await res.json()) as Project };
}

interface Repo {
  id: string;
  full_name: string;
  default_branch: string;
  github_repo_id: number | null;
  index_state: string;
  languages: Record<string, number>;
  file_count: number | null;
  tree_truncated: boolean;
  indexed_at: string | null;
  index_error: string | null;
}
interface Project {
  id: string;
  repos: Repo[];
}

const call = (path: string, cookie: string, init: RequestInit = {}) =>
  exports.default.fetch(new Request(`http://spectrace.test${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...init.headers } }));
const post = (path: string, cookie: string, body?: unknown) => call(path, cookie, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const read = async (cookie: string, id: string) => (await (await call(`/api/projects/${id}`, cookie)).json()) as Project;

interface JobState {
  id: string;
  state: string;
  attempts: number;
  target: string;
}
const jobsOf = async (projectId: string) =>
  (await env.DB.prepare("SELECT id, state, attempts, target FROM jobs WHERE project_id = ?1 AND kind = 'index' ORDER BY rowid").bind(projectId).all<JobState>()).results;

async function deliver(...jobIds: string[]) {
  const batch = createMessageBatch<JobMessage>(
    JOBS_QUEUE,
    jobIds.map((jobId, i) => ({ id: `m${i}-${crypto.randomUUID()}`, timestamp: Date.now(), attempts: 1, body: { jobId } })),
  );
  const ctx = createExecutionContext();
  await worker.queue(batch, env);
  return getQueueResult(batch, ctx);
}

const eventNames = async (jobId: string) =>
  (await env.DB.prepare("SELECT event, data FROM job_events WHERE job_id = ?1 ORDER BY id").bind(jobId).all<{ event: string; data: string }>()).results;

// The queue does not deliver by itself in these tests: `deliver` plays the runtime, so each test decides when a job runs.
const realSend = env.JOBS.send;
beforeEach(() => {
  forgetInstallationTokens();
  mockGithub();
  env.JOBS.send = () => Promise.resolve({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
});
afterEach(() => {
  env.JOBS.send = realSend;
  vi.restoreAllMocks();
});

describe("index job", () => {
  it("queues one job per repo when a project is created, and ends with the repo indexed", async () => {
    const { cookie, project } = await setup(["acme/shop", "acme/empty"]);
    expect(project.repos.map((r) => r.index_state)).toEqual(["pending", "pending"]);
    const jobs = await jobsOf(project.id);
    expect(jobs.map((j) => j.target).sort()).toEqual(project.repos.map((r) => r.id).sort());
    expect(jobs.every((j) => j.state === "queued")).toBe(true);

    expect((await deliver(...jobs.map((j) => j.id))).explicitAcks).toHaveLength(2);

    const done = await read(cookie, project.id);
    const shop = done.repos.find((r) => r.full_name === "acme/shop")!;
    expect(shop).toMatchObject({
      index_state: "ready",
      default_branch: "trunk",
      github_repo_id: 501,
      file_count: 3,
      tree_truncated: false,
      languages: { Rust: 9000, TypeScript: 1200 },
      index_error: null,
    });
    expect(shop.indexed_at).toBeTruthy();
    // A repository with no commits is indexed too, with nothing in it.
    expect(done.repos.find((r) => r.full_name === "acme/empty")).toMatchObject({ index_state: "ready", file_count: 0, languages: {} });
    expect((await jobsOf(project.id)).every((j) => j.state === "succeeded")).toBe(true);
  });

  it("sends progress to watchers and reads the code from one archive, never a clone", async () => {
    const { project } = await setup(["acme/shop"]);
    const [job] = await jobsOf(project.id);
    await deliver(job!.id);
    const events = await eventNames(job!.id);
    expect(events.map((e) => e.event)).toEqual(["queued", "started", "progress", "progress", "progress", "progress", "progress", "succeeded"]);
    const stages = events.filter((e) => e.event === "progress").map((e) => JSON.parse(e.data) as { step: number; steps: number; stage: string; repoId: string });
    expect(stages.map((s) => s.stage)).toEqual([
      "Reading repo details",
      "Reading code, docs and tests",
      "Reading specs, code and tests",
      "Parsing specs and anchors",
      "Reading languages",
    ]);
    expect(stages.every((s) => s.steps === 5 && s.repoId === project.repos[0]!.id)).toBe(true);
    expect(calls.every((c) => c.startsWith("GET /repos/") || c.startsWith("POST /app/installations/"))).toBe(true);
    expect(calls.some((c) => c.includes("clone") || c.includes("zipball"))).toBe(false);
    // The default branch, once; no request per file.
    expect(tarballs).toEqual(["trunk"]);
    expect(calls.some((c) => c.includes("/contents/") || c.includes("/git/blobs/"))).toBe(false);
  });

  it("does not ask for an archive of a repository with no commits", async () => {
    const { project } = await setup(["acme/empty"]);
    await deliver((await jobsOf(project.id))[0]!.id);
    expect(tarballs).toEqual([]);
  });

  it("records a truncated tree", async () => {
    const { cookie, project } = await setup(["acme/big"]);
    await deliver((await jobsOf(project.id))[0]!.id);
    expect((await read(cookie, project.id)).repos[0]).toMatchObject({ index_state: "ready", file_count: 1, tree_truncated: true });
  });

  it("retries a GitHub outage, then succeeds", async () => {
    const { cookie, project } = await setup(["acme/shop"]);
    const [job] = await jobsOf(project.id);
    flaky = 1;
    expect((await deliver(job!.id)).retryMessages).toHaveLength(1);
    expect((await read(cookie, project.id)).repos[0]).toMatchObject({ index_state: "indexing" });
    expect((await deliver(job!.id)).explicitAcks).toHaveLength(1);
    expect((await read(cookie, project.id)).repos[0]).toMatchObject({ index_state: "ready", index_error: null });
  });

  it("fails the repo for good after the last attempt", async () => {
    const { cookie, project } = await setup(["acme/shop"]);
    const [job] = await jobsOf(project.id);
    flaky = 99;
    await deliver(job!.id);
    await deliver(job!.id);
    await deliver(job!.id);
    expect((await jobsOf(project.id))[0]).toMatchObject({ state: "failed", attempts: 3 });
    expect((await read(cookie, project.id)).repos[0]).toMatchObject({ index_state: "failed", index_error: "GitHub languages: status 502" });
  });

  it("fails at once when the App is not installed for the repo, or not for this user", async () => {
    const { cookie, project } = await setup(["acme/nothing", "other/private"]);
    for (const job of await jobsOf(project.id)) expect((await deliver(job.id)).retryMessages).toHaveLength(0);
    const repos = (await read(cookie, project.id)).repos;
    expect(repos.map((r) => r.index_state)).toEqual(["failed", "failed"]);
    expect(repos.every((r) => /GitHub App is not installed on/.test(r.index_error ?? ""))).toBe(true);
    // Never reached the repository itself with someone else's installation.
    expect(calls.some((c) => c === "GET /repos/other/private")).toBe(false);
  });

  it("does nothing for a repo that was removed after it was queued", async () => {
    const { cookie, project } = await setup(["acme/shop"]);
    const [job] = await jobsOf(project.id);
    expect((await call(`/api/projects/${project.id}`, cookie, { method: "PATCH", body: JSON.stringify({ repos: [{ full_name: "acme/empty" }] }) })).status).toBe(200);
    await deliver(job!.id);
    expect((await jobsOf(project.id)).find((j) => j.id === job!.id)?.state).toBe("succeeded");
    expect(calls.filter((c) => c.includes("acme/shop"))).toEqual([]);
  });

  it("indexes only the repos that were added", async () => {
    const { cookie, project } = await setup(["acme/shop"]);
    const res = await call(`/api/projects/${project.id}`, cookie, { method: "PATCH", body: JSON.stringify({ repos: [{ full_name: "acme/shop" }, { full_name: "acme/empty" }] }) });
    const updated = (await res.json()) as Project;
    const added = updated.repos.find((r) => r.full_name === "acme/empty")!;
    const jobs = await jobsOf(project.id);
    expect(jobs.map((j) => j.target).sort()).toEqual([project.repos[0]!.id, added.id].sort());
  });

  it("marks the repo failed, not the request, when the queue is down", async () => {
    env.JOBS.send = () => Promise.reject(new Error("queue down"));
    const { project } = await setup(["acme/shop"]);
    expect(project.repos[0]).toMatchObject({ index_state: "pending" });
    const stored = await env.DB.prepare("SELECT index_state, index_error FROM project_repos WHERE project_id = ?1").bind(project.id).first();
    expect(stored).toEqual({ index_state: "failed", index_error: "could not be queued" });
  });
});

describe("re-index", () => {
  it("queues the repos that are done or failed, and leaves running ones alone", async () => {
    const { cookie, project } = await setup(["acme/shop", "acme/empty", "acme/big"]);
    const first = await jobsOf(project.id);
    await deliver(first[0]!.id, first[1]!.id); // shop and empty ready; big still pending
    expect((await jobsOf(project.id)).length).toBe(3);

    const res = await post(`/api/projects/${project.id}/reindex`, cookie);
    expect(res.status).toBe(200);
    const after = (await res.json()) as Project;
    expect(after.repos.map((r) => r.index_state)).toEqual(["pending", "pending", "pending"]);
    expect((await jobsOf(project.id)).length).toBe(5); // two new jobs; the pending one kept its own

    const fresh = (await jobsOf(project.id)).filter((j) => j.state === "queued");
    await deliver(...fresh.map((j) => j.id));
    expect((await read(cookie, project.id)).repos.map((r) => r.index_state)).toEqual(["ready", "ready", "ready"]);
  });

  it("is only for the owner", async () => {
    const { project } = await setup(["acme/shop"]);
    const other = await setup([]);
    expect((await post(`/api/projects/${project.id}/reindex`, other.cookie)).status).toBe(404);
    expect((await post(`/api/projects/${project.id}/reindex`, "")).status).toBe(401);
  });
});

interface SpecSummary {
  id: string;
  repo: string;
  path: string;
  root: string;
  area: string;
  flow: string;
  title: string;
  steps: number;
  requirements: number;
  tested: number;
  errors: number;
  edges: { from: string; label: string; to: string }[];
}
interface SpecDetail extends SpecSummary {
  source: string;
  defaultBranch: string;
  model: { flow: string; sections: { id: string; title: string; requirements: { tag: string; condition: string }[] }[] } | null;
  diagnostics: { code: string; line: number; message: string }[];
  anchors: { path: string; line: number; kind: string; class: string; target: string; note: string | null; excerpt: string }[];
}

const specsOf = async (cookie: string, projectId: string) => (await (await call(`/api/projects/${projectId}/specs`, cookie)).json()) as SpecSummary[];

describe("spec index", () => {
  it("fills specs, edges and anchors from the fixture repo, and serves them", async () => {
    const { cookie, project } = await setup(["acme/shop"]);
    await deliver((await jobsOf(project.id))[0]!.id);

    const list = await specsOf(cookie, project.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ repo: "acme/shop", path: "spec/checkout.md", root: "", area: "", flow: "checkout", title: "Checkout", steps: 5, requirements: 9, errors: 0 });
    // checkout.details has no tests on purpose: 7 of 9 requirements are tested.
    expect(list[0]!.tested).toBe(7);
    expect(list[0]!.edges).toContainEqual({ from: "pay", label: "declined", to: "failed" });
    expect(list[0]!.edges).toHaveLength(5);

    const res = await call(`/api/projects/${project.id}/specs/${list[0]!.id}`, cookie);
    expect(res.status).toBe(200);
    const spec = (await res.json()) as SpecDetail;
    expect(spec.source).toBe(SHOP["spec/checkout.md"]);
    expect(spec.defaultBranch).toBe("trunk");
    expect(spec.model?.sections.map((s) => s.id)).toEqual(["checkout.cart", "checkout.details", "checkout.pay", "checkout.failed", "checkout.paid"]);
    expect(spec.diagnostics.filter((d) => d.code.startsWith("S"))).toEqual([]);

    const retry = spec.anchors.find((a) => a.target === "checkout.failed/r2");
    expect(retry).toMatchObject({ path: "tests/checkout.rs", kind: "spec", class: "test" });
    expect(retry!.excerpt).toContain("fn retry_limit_is_3()");
    const pay = spec.anchors.find((a) => a.target === "checkout.pay" && a.kind === "spec");
    expect(pay).toMatchObject({ path: "src/checkout.rs", class: "code" });
    expect(pay!.excerpt.split("\n")[0]).toBe('#[spec("checkout.pay")]');
    expect(pay!.excerpt.trimEnd().endsWith("}")).toBe(true);
    const flow = spec.anchors.find((a) => a.kind === "flow" && a.target === "checkout.cart");
    expect(flow).toMatchObject({ path: "src/cart.rs", note: "re-check stock, cache may be stale" });
  });

  it("keeps a spec's id across re-indexing, shows errors, and drops specs that are gone", async () => {
    const { cookie, project } = await setup(["acme/shop"]);
    await deliver((await jobsOf(project.id))[0]!.id);
    const [before] = await specsOf(cookie, project.id);

    REPOS["acme/shop"]!.files = {
      ...SHOP,
      "spec/README.md": "# Specs\n\nNot a flow.",
      "spec/orders/refunds.md": "# Refunds {#refunds}\n\nno diagram yet\n",
      "docs/notes.md": "# Not a spec",
      "node_modules/x/spec/checkout.md": SHOP["spec/checkout.md"]!,
    };
    try {
      expect((await post(`/api/projects/${project.id}/reindex`, cookie)).status).toBe(200);
      const queued = (await jobsOf(project.id)).filter((j) => j.state === "queued");
      await deliver(...queued.map((j) => j.id));
      const after = await specsOf(cookie, project.id);
      expect(after.map((s) => s.path)).toEqual(["spec/checkout.md", "spec/orders/refunds.md"]);
      expect(after[0]!.id).toBe(before!.id);
      const refunds = after[1]!;
      expect(refunds).toMatchObject({ area: "orders", flow: "refunds", title: "refunds", steps: 0 });
      expect(refunds.errors).toBeGreaterThan(0);
      const detail = (await (await call(`/api/projects/${project.id}/specs/${refunds.id}`, cookie)).json()) as SpecDetail;
      expect(detail.model).toBeNull();
      expect(detail.diagnostics.some((d) => d.code === "S002")).toBe(true);

      REPOS["acme/shop"]!.files = { "spec/orders/refunds.md": "# Refunds {#refunds}\n" };
      await post(`/api/projects/${project.id}/reindex`, cookie);
      await deliver(...(await jobsOf(project.id)).filter((j) => j.state === "queued").map((j) => j.id));
      expect((await specsOf(cookie, project.id)).map((s) => s.path)).toEqual(["spec/orders/refunds.md"]);
      expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM anchors a JOIN project_repos r ON r.id = a.repo_id WHERE r.project_id = ?1").bind(project.id).first<{ n: number }>())?.n).toBe(0);
    } finally {
      REPOS["acme/shop"]!.files = SHOP;
    }
  });

  it("is only for the owner, and 404s an unknown spec", async () => {
    const { cookie, project } = await setup(["acme/shop"]);
    await deliver((await jobsOf(project.id))[0]!.id);
    const [spec] = await specsOf(cookie, project.id);
    const other = await setup([]);
    expect((await call(`/api/projects/${project.id}/specs`, other.cookie)).status).toBe(404);
    expect((await call(`/api/projects/${project.id}/specs/${spec!.id}`, other.cookie)).status).toBe(404);
    expect((await call(`/api/projects/${project.id}/specs`, "")).status).toBe(401);
    expect((await call(`/api/projects/${project.id}/specs/nope`, cookie)).status).toBe(404);
    // Another project's spec is not reachable through this project.
    expect((await call(`/api/projects/${other.project.id}/specs/${spec!.id}`, other.cookie)).status).toBe(404);
  });
});

describe("devpage", () => {
  const detailOf = async (cookie: string, projectId: string, specId: string) =>
    (await (await call(`/api/projects/${projectId}/specs/${specId}`, cookie)).json()) as SpecDetail & { devpage: { id: string; version: number; url: string } | null };
  const reindex = async (cookie: string, projectId: string) => {
    await post(`/api/projects/${projectId}/reindex`, cookie);
    await deliver(...(await jobsOf(projectId)).filter((j) => j.state === "queued").map((j) => j.id));
  };

  it("publishes each spec once per change and serves its page on this origin, to the owner only", async () => {
    const { cookie, project } = await setup(["acme/shop"]);
    await deliver((await jobsOf(project.id))[0]!.id);
    const [spec] = await specsOf(cookie, project.id);

    // Version 1: the spec file alone, as the document's entry.
    expect(devpageCalls).toEqual([{ req: "POST /api/documents?entry=checkout.md", author: "spectrace", file: { path: "checkout.md", text: SHOP["spec/checkout.md"] } }]);
    const detail = await detailOf(cookie, project.id, spec!.id);
    expect(detail.devpage).toMatchObject({ version: 1 });
    expect(detail.devpage!.url).toBe(`/d/${detail.devpage!.id}/`);

    // The page is proxied for the owner, as them; its cookie never reaches devpage.
    devpageCalls = [];
    const page = await call(detail.devpage!.url, cookie);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(`<h1>devpage ${detail.devpage!.id} v1</h1>`);
    const login = cookie.replace("spectrace_session=", "");
    expect(devpageCalls).toEqual([{ req: `GET /d/${detail.devpage!.id}/`, author: login }]);
    expect((await call("/__devpage/app.css", cookie)).status).toBe(200);

    // Nobody else reaches it, signed in or not; an unknown document is a 404 before devpage is asked.
    const other = await setup([]);
    devpageCalls = [];
    expect((await call(detail.devpage!.url, other.cookie)).status).toBe(404);
    expect((await call(detail.devpage!.url, "")).status).toBe(401);
    expect((await call(`/d/${crypto.randomUUID()}/`, cookie)).status).toBe(404);
    expect(devpageCalls).toEqual([]);

    // Unchanged on re-index: nothing is published. Changed: the next version of the same document.
    await reindex(cookie, project.id);
    expect(devpageCalls).toEqual([]);
    const changed = SHOP["spec/checkout.md"]!.replace("disable the checkout button", "hide the checkout button");
    REPOS["acme/shop"]!.files = { ...SHOP, "spec/checkout.md": changed };
    try {
      await reindex(cookie, project.id);
      expect(devpageCalls.map((c) => c.req)).toEqual([`POST /api/documents/${detail.devpage!.id}/versions?entry=checkout.md`]);
      expect(devpageCalls[0]!.file?.text).toBe(changed);
      expect((await detailOf(cookie, project.id, spec!.id)).devpage).toMatchObject({ id: detail.devpage!.id, version: 2 });
    } finally {
      REPOS["acme/shop"]!.files = SHOP;
    }
  });

  it("keeps the index when devpage refuses a spec, and tries again on the next index", async () => {
    const { cookie, project } = await setup(["acme/shop"]);
    devpageRefuses = true;
    await deliver((await jobsOf(project.id))[0]!.id);
    const [spec] = await specsOf(cookie, project.id);
    expect(spec).toMatchObject({ steps: 5 });
    expect((await read(cookie, project.id)).repos[0]!.index_state).toBe("ready");
    expect((await detailOf(cookie, project.id, spec!.id)).devpage).toBeNull();

    devpageRefuses = false;
    devpageCalls = [];
    await reindex(cookie, project.id);
    expect(devpageCalls.map((c) => c.req)).toEqual(["POST /api/documents?entry=checkout.md"]);
    expect((await detailOf(cookie, project.id, spec!.id)).devpage).toMatchObject({ version: 1 });
  });
});

describe("saving an edited spec", () => {
  const save = (cookie: string, projectId: string, specId: string, body: unknown) =>
    call(`/api/projects/${projectId}/specs/${specId}/changes`, cookie, { method: "POST", body: JSON.stringify(body) });

  it("commits the edited file on a new branch and opens a pull request", async () => {
    const { cookie, project } = await setup(["acme/shop"]);
    await deliver((await jobsOf(project.id))[0]!.id);
    const [spec] = await specsOf(cookie, project.id);
    const edited = SHOP["spec/checkout.md"]!.replace("failed[Declined]", "failed[Payment declined]").replace("## Declined payment {#checkout.failed}", "## Payment declined {#checkout.failed}");

    const res = await save(cookie, project.id, spec!.id, { source: edited, summary: ["Renamed Declined to Payment declined"] });
    expect(res.status).toBe(201);
    const opened = (await res.json()) as { number: number; url: string; branch: string };
    expect(opened).toMatchObject({ number: 7, url: "https://github.com/acme/shop/pull/7" });
    expect(opened.branch).toMatch(/^spectrace\/spec-checkout-[a-z0-9]+$/);

    expect(ghWrites.map((w) => w.req)).toEqual(["POST /git/refs", "PUT /contents/spec/checkout.md", "POST /pulls"]);
    expect(ghWrites[0]!.body).toEqual({ ref: `refs/heads/${opened.branch}`, sha: "base-sha" });
    const put = ghWrites[1]!.body as { content: string; sha: string; branch: string; message: string };
    expect(new TextDecoder().decode(Uint8Array.from(atob(put.content), (ch) => ch.charCodeAt(0)))).toBe(edited);
    expect(put).toMatchObject({ sha: "blob-1", branch: opened.branch, message: "Edit spec/checkout.md\n\n- Renamed Declined to Payment declined" });
    expect(ghWrites[2]!.body).toMatchObject({ title: "Spec: Checkout (1 change)", head: opened.branch, base: "trunk" });
  });

  it("refuses no change, a spec with errors, a spec changed on GitHub, and other users", async () => {
    const { cookie, project } = await setup(["acme/shop"]);
    await deliver((await jobsOf(project.id))[0]!.id);
    const [spec] = await specsOf(cookie, project.id);
    const source = SHOP["spec/checkout.md"]!;

    expect((await save(cookie, project.id, spec!.id, { source, summary: [] })).status).toBe(400);
    const broken = await save(cookie, project.id, spec!.id, { source: source.replace("  cart -->|start| details\n", "  cart -->|start| nowhere\n"), summary: [] });
    expect(broken.status).toBe(400);
    expect(((await broken.json()) as { error: { message: string } }).error.message).toContain("errors");
    const other = await setup([]);
    expect((await save(other.cookie, project.id, spec!.id, { source: `${source}\n`, summary: [] })).status).toBe(404);

    REPOS["acme/shop"]!.files = { ...SHOP, "spec/checkout.md": source.replace("disable the checkout button", "hide the checkout button") };
    try {
      const stale = await save(cookie, project.id, spec!.id, { source: source.replace("show the reason", "show why"), summary: ["x"] });
      expect(stale.status).toBe(409);
      expect(((await stale.json()) as { error: { message: string } }).error.message).toContain("changed on trunk");
    } finally {
      REPOS["acme/shop"]!.files = SHOP;
    }
    expect(ghWrites).toEqual([]);
  });
});
