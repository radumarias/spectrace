import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { hashToken } from "../src/auth";
import { forgetInstallationTokens } from "../src/github-app";
import { JOBS_QUEUE, type JobMessage } from "../src/jobs/queue";
import pullsOpen from "./recorded/pulls-open.json";
import files7 from "./recorded/files-7.json";
import files9 from "./recorded/files-9.json";

// GitHub is never called: every request to the API host is answered from the
// recorded responses in test/recorded/ (shaped like GitHub's own).
type Pull = (typeof pullsOpen)[number];
let pulls: Pull[];
let files: Record<number, unknown[]>;
let requests: string[];
/** Pull requests no longer open on GitHub, by number (what `GET /pulls/{n}` answers). */
let closed: Record<number, { merged_at: string | null }>;
/** What `GET /pulls?state=closed` lists: recently closed pull requests, merged ones with `merged_at`. */
let closedList: unknown[] = [];
/** The account the App is installed on for acme/shop, as `GET /repos/acme/shop/installation` answers; null = not installed. */
let installedOn: { id: number; account: { id: number; login: string; type: string } } | null = null;

function mockGithub() {
  requests = [];
  const real = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    if (url.origin !== "http://api.github.test") return real(input, init);
    const path = url.pathname;
    requests.push(`${path}?${url.searchParams.get("page") ?? ""}`);
    if (/^\/app\/installations\/\d+\/access_tokens$/.test(path)) {
      return Response.json({ token: "ghs_test", expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 });
    }
    if (path === "/repos/acme/shop/installation") return installedOn ? Response.json(installedOn) : Response.json({}, { status: 404 });
    if (req.headers.get("authorization") !== "Bearer ghs_test") return Response.json({}, { status: 401 });
    const page = Number(url.searchParams.get("page") ?? "1");
    const slice = (all: unknown[]) => all.slice((page - 1) * 100, page * 100);
    if (path === "/repos/acme/shop/pulls") return Response.json(slice(url.searchParams.get("state") === "closed" ? closedList : pulls));
    const f = /^\/repos\/acme\/shop\/pulls\/(\d+)\/files$/.exec(path);
    if (f) return Response.json(slice(files[Number(f[1])] ?? []));
    const d = /^\/repos\/acme\/shop\/pulls\/(\d+)$/.exec(path);
    if (d && closed[Number(d[1])]) return Response.json({ number: Number(d[1]), state: "closed", ...closed[Number(d[1])] });
    return Response.json({ message: "Not Found" }, { status: 404 });
  });
}

let n = 0;
async function setup(opts: { installation?: boolean } = {}) {
  const userId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO users (id, github_id, login) VALUES (?1, ?2, ?3)").bind(userId, 2_000_000 + ++n, `u${n}-${userId.slice(0, 6)}`).run();
  const projectId = `proj-${userId}`;
  await env.DB.prepare("INSERT INTO projects (id, owner_id, name) VALUES (?1, ?2, 'p')").bind(projectId, userId).run();
  const repoId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO project_repos (id, project_id, full_name) VALUES (?1, ?2, 'acme/shop')").bind(repoId, projectId).run();
  if (opts.installation !== false) {
    const instId = 5000 + n;
    await env.DB.prepare("INSERT INTO github_installations (id, account_id, account_login, account_type, repository_selection) VALUES (?1, 1, 'Acme', 'Organization', 'all')").bind(instId).run();
    await env.DB.prepare("INSERT INTO user_installations (user_id, installation_id) VALUES (?1, ?2)").bind(userId, instId).run();
  }
  return { userId, projectId, repoId };
}

/** Queue a sync job as the API would and deliver it as the queue would. */
async function runSync(projectId: string, target = "") {
  const jobId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO jobs (id, project_id, kind, target, max_attempts) VALUES (?1, ?2, 'sync', ?3, 1)").bind(jobId, projectId, target).run();
  const batch = createMessageBatch<JobMessage>(JOBS_QUEUE, [{ id: `m-${jobId}`, timestamp: Date.now(), attempts: 1, body: { jobId } }]);
  const ctx = createExecutionContext();
  await worker.queue(batch, env);
  await getQueueResult(batch, ctx);
  return env.DB.prepare("SELECT state, error FROM jobs WHERE id = ?1").bind(jobId).first<{ state: string; error: string | null }>();
}

const prs = (repoId: string) =>
  env.DB.prepare("SELECT number, title, body, author_login, state, draft, head_ref, head_sha, base_ref, additions, deletions, changed_files FROM pull_requests WHERE repo_id = ?1 ORDER BY number")
    .bind(repoId)
    .all();
const filesOf = async (repoId: string, number: number) =>
  (
    await env.DB.prepare(
      "SELECT f.path, f.status, f.previous_path, f.additions, f.deletions FROM pr_files f JOIN pull_requests p ON p.id = f.pull_request_id WHERE p.repo_id = ?1 AND p.number = ?2 ORDER BY f.path",
    )
      .bind(repoId, number)
      .all()
  ).results;

beforeEach(() => {
  forgetInstallationTokens();
  pulls = structuredClone(pullsOpen);
  closed = {};
  closedList = [];
  installedOn = null;
  files = { 7: structuredClone(files7), 9: structuredClone(files9) };
  mockGithub();
});
afterEach(() => vi.restoreAllMocks());

describe("sync job", () => {
  it("picks up an installation made outside spectrace when it is on the owner's own account", async () => {
    const { projectId, userId } = await setup({ installation: false });
    const login = (await env.DB.prepare("SELECT login FROM users WHERE id = ?1").bind(userId).first<{ login: string }>())!.login;
    installedOn = { id: 777, account: { id: 1, login, type: "User" } };
    expect(await runSync(projectId)).toEqual({ state: "succeeded", error: null });
    expect((await env.DB.prepare("SELECT installation_id FROM user_installations WHERE user_id = ?1").bind(userId).all()).results).toEqual([{ installation_id: 777 }]);
  });

  it("does not link an installation that belongs to someone else", async () => {
    const { projectId } = await setup({ installation: false });
    installedOn = { id: 778, account: { id: 2, login: "someone-else", type: "User" } };
    expect((await runSync(projectId))?.state).toBe("failed");
  });

  it("stores recently merged and closed pull requests that were never seen open", async () => {
    const { projectId, repoId } = await setup();
    const base = pullsOpen[0]!;
    closedList = [
      { ...base, number: 3, id: 303, title: "Shipped", state: "closed", merged_at: "2026-11-20T10:00:00Z" },
      { ...base, number: 4, id: 304, title: "Dropped", state: "closed", merged_at: null },
    ];
    expect(await runSync(projectId)).toEqual({ state: "succeeded", error: null });
    expect((await env.DB.prepare("SELECT number, state, merged_at FROM pull_requests WHERE repo_id = ?1 AND number IN (3, 4) ORDER BY number").bind(repoId).all()).results).toEqual([
      { number: 3, state: "closed", merged_at: "2026-11-20T10:00:00Z" },
      { number: 4, state: "closed", merged_at: null },
    ]);
  });

  it("stores the open pull requests and their files", async () => {
    const { projectId, repoId } = await setup();
    expect(await runSync(projectId)).toEqual({ state: "succeeded", error: null });

    expect((await prs(repoId)).results).toEqual([
      { number: 7, title: "Add coupon field to checkout", body: "Lets shoppers enter a coupon code.\n\nCloses #3", author_login: "mona", state: "open", draft: 0, head_ref: "feat/coupon", head_sha: "aaa111", base_ref: "main", additions: 46, deletions: 2, changed_files: 2 },
      { number: 9, title: "Rename cart totals", body: "", author_login: "octocat", state: "open", draft: 1, head_ref: "chore/totals", head_sha: "bbb222", base_ref: "main", additions: 3, deletions: 3, changed_files: 1 },
    ]);
    expect(await filesOf(repoId, 7)).toEqual([
      { path: "src/checkout/coupon.ts", status: "added", previous_path: null, additions: 40, deletions: 0 },
      { path: "src/checkout/pay.ts", status: "modified", previous_path: null, additions: 6, deletions: 2 },
    ]);
    expect(await filesOf(repoId, 9)).toEqual([{ path: "src/cart/totals.ts", status: "renamed", previous_path: "src/cart/sum.ts", additions: 3, deletions: 3 }]);
  });

  it("is idempotent, re-reads files only when the head moved, and closes PRs GitHub no longer lists", async () => {
    const { projectId, repoId } = await setup();
    await runSync(projectId);
    const idsBefore = (await env.DB.prepare("SELECT id FROM pull_requests WHERE repo_id = ?1 ORDER BY number").bind(repoId).all()).results;

    // PR 7 gets a new commit and a new title; PR 9 is merged (gone from the open list).
    closed = { 9: { merged_at: "2026-11-21T09:00:00Z" } };
    pulls = [{ ...pulls[0]!, title: "Add coupon field", head: { ref: "feat/coupon", sha: "ccc333" } }];
    files[7] = [{ filename: "src/checkout/coupon.ts", status: "added", additions: 50, deletions: 0 }];
    requests.length = 0;
    expect(await runSync(projectId)).toEqual({ state: "succeeded", error: null });

    expect((await prs(repoId)).results.map((r) => [r.number, r.title, r.state, r.head_sha, r.additions, r.changed_files])).toEqual([
      [7, "Add coupon field", "open", "ccc333", 50, 1],
      [9, "Rename cart totals", "closed", "bbb222", 3, 1],
    ]);
    expect((await env.DB.prepare("SELECT number, merged_at FROM pull_requests WHERE repo_id = ?1 ORDER BY number").bind(repoId).all()).results).toEqual([
      { number: 7, merged_at: null },
      { number: 9, merged_at: "2026-11-21T09:00:00Z" },
    ]);
    expect(await filesOf(repoId, 7)).toHaveLength(1);
    expect(await filesOf(repoId, 9)).toHaveLength(1); // kept for history
    expect((await env.DB.prepare("SELECT id FROM pull_requests WHERE repo_id = ?1 ORDER BY number").bind(repoId).all()).results).toEqual(idsBefore);

    // Nothing moved: no file requests at all.
    requests.length = 0;
    await runSync(projectId);
    expect(requests.filter((r) => r.includes("/files"))).toEqual([]);
  });

  it("records a PR closed without merging as closed, with no merge time", async () => {
    const { projectId, repoId } = await setup();
    await runSync(projectId);
    pulls = [pulls[0]!];
    closed = { 9: { merged_at: null } };
    await runSync(projectId);
    expect((await env.DB.prepare("SELECT state, merged_at FROM pull_requests WHERE repo_id = ?1 AND number = 9").bind(repoId).first())).toEqual({ state: "closed", merged_at: null });
  });

  it("reads every page of a PR's files", async () => {
    const { projectId, repoId } = await setup();
    files[7] = Array.from({ length: 130 }, (_, i) => ({ filename: `src/f${String(i).padStart(3, "0")}.ts`, status: "modified", additions: 1, deletions: 0 }));
    await runSync(projectId);
    expect(await filesOf(repoId, 7)).toHaveLength(130);
    expect((await prs(repoId)).results[0]).toMatchObject({ number: 7, additions: 130, changed_files: 130 });
  });

  it("fails permanently when the app is not installed on the repo's owner", async () => {
    const { projectId, repoId } = await setup({ installation: false });
    const job = await runSync(projectId);
    expect(job?.state).toBe("failed");
    expect(job?.error).toContain("no GitHub App installation for acme/shop");
    expect((await prs(repoId)).results).toEqual([]);
  });

  it("fails permanently for a target that is not a repo of the project", async () => {
    const { projectId } = await setup();
    const job = await runSync(projectId, "acme/other");
    expect(job).toMatchObject({ state: "failed" });
    expect(job?.error).toContain("not a repository of this project");
  });

  it("can be queued through the jobs API", async () => {
    const { userId, projectId } = await setup();
    const login = `sync-${crypto.randomUUID().slice(0, 8)}`;
    await env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?1, ?2, ?3, ?4)")
      .bind(crypto.randomUUID(), userId, await hashToken(login), new Date(Date.now() + 86_400_000).toISOString())
      .run();
    const res = await exports.default.fetch(
      new Request(`http://spectrace.test/api/projects/${projectId}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `spectrace_session=${login}` },
        body: JSON.stringify({ kind: "sync" }),
      }),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ kind: "sync", state: "queued" });
  });
});
