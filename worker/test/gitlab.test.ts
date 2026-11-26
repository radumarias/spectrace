import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { hashToken } from "../src/auth";
import { toCheckRun, toFile, toPull } from "../src/git/gitlab";
import { gitlabPath } from "../src/routes/projects";
import { isoTime } from "../src/routes/gitlab-webhook";
import { JOBS_QUEUE, type JobMessage } from "../src/jobs/queue";
import { SHOP } from "./fixtures";
import { tarGz } from "./tar";

// GitLab is never called: http://gitlab.test is a fake shaped like GitLab's REST API v4,
// with one project, group/sub/shop, and recorded-style answers.
const API = "/api/v4/projects/group%2Fsub%2Fshop";
const TOKEN = "glpat-test";

const mr = (iid: number, over: Record<string, unknown> = {}) => ({
  id: 9000 + iid,
  iid,
  title: `MR ${iid}`,
  description: "Adds checkout",
  state: "opened",
  draft: false,
  web_url: `http://gitlab.test/group/sub/shop/-/merge_requests/${iid}`,
  author: { id: 5, username: "mona" },
  source_branch: `feat-${iid}`,
  target_branch: "main",
  sha: `sha${iid}`,
  created_at: "2026-11-20T10:00:00.000Z",
  updated_at: "2026-11-21T10:00:00.000Z",
  merged_at: null,
  ...over,
});

let mrs: ReturnType<typeof mr>[];
let merged: ReturnType<typeof mr>[];
let approvedBy: string[];
let sent: { method: string; path: string; body: unknown }[];
let mergeStatus: number;
let hooks: { url: string }[];

function fakeGitlab() {
  const real = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    if (url.origin !== "http://gitlab.test") return real(input, init);
    const path = url.pathname;
    const body = req.method === "GET" ? null : await req.text().then((t) => (t ? (JSON.parse(t.startsWith("{") ? t : "{}") as unknown) : null));
    if (req.method !== "GET") sent.push({ method: req.method, path, body });
    if (path === "/oauth/token") {
      const form = new URLSearchParams(await new Request(input as RequestInfo, init).arrayBuffer().then((b) => new TextDecoder().decode(b)));
      if (form.get("code") === "good" || form.get("grant_type") === "refresh_token") return Response.json({ access_token: TOKEN, refresh_token: "rt2", expires_in: 7200, token_type: "Bearer" });
      return Response.json({ error: "invalid_grant", error_description: "bad code" }, { status: 400 });
    }
    if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ message: "401 Unauthorized" }, { status: 401 });
    if (path === "/api/v4/user") return Response.json({ id: 42, username: "radu", name: "Radu" });
    if (path === "/api/v4/projects") {
      return Response.json(url.searchParams.get("page") === "1" ? [{ id: 77, path_with_namespace: "group/sub/shop", name: "shop", default_branch: "main", visibility: "private", web_url: "http://gitlab.test/group/sub/shop" }] : []);
    }
    if (!path.startsWith(API)) return Response.json({ message: "404 Project Not Found" }, { status: 404 });
    const rest = path.slice(API.length);
    if (rest === "/merge_requests" && req.method === "GET") {
      const state = url.searchParams.get("state");
      if (state === "opened") return Response.json(url.searchParams.get("page") === "1" ? mrs : []);
      return Response.json(state === "merged" ? merged : []);
    }
    let m = /^\/merge_requests\/(\d+)$/.exec(rest);
    if (m) {
      const found = [...mrs, ...merged].find((x) => x.iid === Number(m![1]));
      return found ? Response.json(found) : Response.json({ message: "404 Not found" }, { status: 404 });
    }
    m = /^\/merge_requests\/(\d+)\/diffs$/.exec(rest);
    if (m) {
      return Response.json(
        url.searchParams.get("page") === "1"
          ? [
              { old_path: "src/cart.rs", new_path: "src/cart.rs", new_file: false, renamed_file: false, deleted_file: false, diff: "@@ -1,2 +1,2 @@\n-old\n+new\n ctx" },
              { old_path: "a.png", new_path: "a.png", new_file: true, renamed_file: false, deleted_file: false, diff: "" },
              { old_path: "x.rs", new_path: "y.rs", new_file: false, renamed_file: true, deleted_file: false, diff: "@@ -1 +1,2 @@\n+one\n+two" },
            ]
          : [],
      );
    }
    if (/^\/merge_requests\/\d+\/approvals$/.test(rest)) return Response.json({ approved_by: approvedBy.map((u, i) => ({ user: { id: 100 + i, username: u } })) });
    if (/^\/merge_requests\/\d+\/approve$/.test(rest)) return Response.json({ approved: true }, { status: 201 });
    if (/^\/merge_requests\/\d+\/unapprove$/.test(rest)) return Response.json({}, { status: 201 });
    if (/^\/merge_requests\/\d+\/notes$/.test(rest)) return Response.json({ id: 555 }, { status: 201 });
    if (/^\/merge_requests\/\d+\/merge$/.test(rest)) return Response.json(mergeStatus === 200 ? { state: "merged" } : { message: "Branch cannot be merged" }, { status: mergeStatus });
    if (rest === "/pipelines") return Response.json(url.searchParams.get("sha") === "sha7" ? [{ id: 31, sha: "sha7", status: "running" }] : []);
    if (rest === "/pipelines/31/jobs") {
      return Response.json([
        { id: 301, name: "test", status: "success", web_url: "http://gitlab.test/j/301", started_at: "2026-11-21T10:00:00Z", finished_at: "2026-11-21T10:05:00Z" },
        { id: 302, name: "lint", status: "running", web_url: "http://gitlab.test/j/302" },
      ]);
    }
    if (rest === "") return Response.json({ id: 77, path_with_namespace: "group/sub/shop", default_branch: "main" });
    if (rest === "/repository/branches/main") return Response.json({ name: "main", commit: { id: "headsha" } });
    if (rest === "/repository/tree") return Response.json(url.searchParams.get("page") === "1" ? Object.keys(SHOP).map((p) => ({ type: "blob", path: p })) : []);
    if (rest === "/repository/archive.tar.gz") return new Response(await tarGz(SHOP, "shop-main-headsha"));
    if (rest === "/languages") return Response.json({ Rust: 100 });
    if (rest === "/hooks") {
      if (req.method === "POST") {
        hooks.push(body as { url: string });
        return Response.json({ id: 1 }, { status: 201 });
      }
      return Response.json(hooks);
    }
    return Response.json({ message: "404 Not Found" }, { status: 404 });
  });
}

let n = 0;
async function seed(opts: { connected?: boolean; repo?: boolean } = {}) {
  const login = `gl-${++n}-${crypto.randomUUID().slice(0, 8)}`;
  const userId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO users (id, github_id, login) VALUES (?1, ?2, ?3)").bind(userId, 8_000_000 + n, login).run();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(crypto.randomUUID(), userId, await hashToken(login), new Date(Date.now() + 86_400_000).toISOString())
    .run();
  const projectId = `proj-${userId}`;
  await env.DB.prepare("INSERT INTO projects (id, owner_id, name) VALUES (?1, ?2, 'p')").bind(projectId, userId).run();
  const cookie = `spectrace_session=${login}`;
  if (opts.connected !== false) {
    const res = await call("/api/gitlab/token", cookie, { method: "POST", json: { token: TOKEN } });
    expect(res.status).toBe(200);
  }
  const repoId = crypto.randomUUID();
  if (opts.repo !== false) {
    await env.DB.prepare("INSERT INTO project_repos (id, project_id, full_name, provider) VALUES (?1, ?2, 'group/sub/shop', 'gitlab')").bind(repoId, projectId).run();
  }
  return { userId, projectId, repoId, cookie };
}

function call(path: string, cookie: string | null, init: RequestInit & { json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    init = { ...init, body: JSON.stringify(init.json) };
  }
  return exports.default.fetch(new Request(`http://spectrace.test${path}`, { ...init, headers, redirect: "manual" }));
}

async function runJob(projectId: string, kind: string, target: string) {
  const jobId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO jobs (id, project_id, kind, target, max_attempts) VALUES (?1, ?2, ?3, ?4, 1)").bind(jobId, projectId, kind, target).run();
  const batch = createMessageBatch<JobMessage>(JOBS_QUEUE, [{ id: `m-${jobId}`, timestamp: Date.now(), attempts: 1, body: { jobId } }]);
  await worker.queue(batch, env);
  await getQueueResult(batch, createExecutionContext());
  return env.DB.prepare("SELECT state, error FROM jobs WHERE id = ?1").bind(jobId).first<{ state: string; error: string | null }>();
}

const hook = (event: string, payload: unknown, token = "glwh-test") =>
  call("/api/gitlab/webhook", null, { method: "POST", headers: { "x-gitlab-event": event, "x-gitlab-token": token, "x-gitlab-event-uuid": crypto.randomUUID() }, json: payload });

beforeEach(() => {
  mrs = [mr(7)];
  merged = [];
  approvedBy = [];
  sent = [];
  mergeStatus = 200;
  hooks = [];
  fakeGitlab();
});
afterEach(() => vi.restoreAllMocks());

describe("GitLab shapes", () => {
  it("maps merge requests, diffs and jobs to the stored shapes", () => {
    expect(toPull(mr(3, { state: "merged", merged_at: "2026-11-22T00:00:00Z" }))).toMatchObject({ number: 3, id: 9003, state: "closed", merged_at: "2026-11-22T00:00:00Z", head: { ref: "feat-3", sha: "sha3" }, user: { login: "mona" } });
    expect(toPull(mr(4, { draft: true }))).toMatchObject({ state: "open", draft: true, merged_at: null });
    expect(toFile({ old_path: "a", new_path: "b", new_file: false, renamed_file: true, deleted_file: false, diff: "@@ -1 +1 @@\n-x\n+y\n+z" })).toEqual({
      filename: "b",
      status: "renamed",
      previous_filename: "a",
      additions: 2,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-x\n+y\n+z",
    });
    expect(toCheckRun({ id: 1, name: "t", status: "failed", allow_failure: true }, "s")).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(toCheckRun({ id: 1, name: "t", status: "pending" }, "s")).toMatchObject({ status: "queued", conclusion: null });
  });

  it("reads GitLab links and hook times", () => {
    expect(gitlabPath("https://gitlab.test/group/sub/shop/-/merge_requests/3", "http://gitlab.test")).toBe("group/sub/shop");
    expect(gitlabPath("gitlab.test/group/shop.git", "http://gitlab.test")).toBe("group/shop");
    expect(gitlabPath("https://github.com/acme/shop", "http://gitlab.test")).toBeNull();
    expect(isoTime("2026-11-26 10:00:00 UTC")).toBe("2026-11-26T10:00:00.000Z");
    expect(isoTime("2026-11-26 11:00:00 +0100")).toBe("2026-11-26T10:00:00.000Z");
  });
});

describe("GitLab account", () => {
  it("connects with a token, lists repos and disconnects", async () => {
    const { cookie } = await seed({ repo: false, connected: false });
    expect(await (await call("/api/gitlab", cookie)).json()).toEqual({ configured: true, url: "http://gitlab.test", oauth: true, account: null });
    expect(await (await call("/api/gitlab/repos", cookie)).json()).toEqual([]);
    expect((await call("/api/gitlab/token", cookie, { method: "POST", json: { token: "wrong" } })).status).toBe(400);
    const ok = await call("/api/gitlab/token", cookie, { method: "POST", json: { token: TOKEN } });
    expect(await ok.json()).toMatchObject({ account: { username: "radu", kind: "token" } });
    // The token is sealed, never stored as typed.
    const stored = await env.DB.prepare("SELECT access_token FROM gitlab_connections WHERE username = 'radu' ORDER BY created_at DESC LIMIT 1").first<{ access_token: string }>();
    expect(stored?.access_token).not.toContain(TOKEN);
    expect(await (await call("/api/gitlab/repos", cookie)).json()).toEqual([{ id: 77, full_name: "group/sub/shop", name: "shop", default_branch: "main", private: true, html_url: "http://gitlab.test/group/sub/shop" }]);
    expect((await call("/api/gitlab", cookie, { method: "DELETE" })).status).toBe(204);
    expect(((await (await call("/api/gitlab", cookie)).json()) as { account: unknown }).account).toBeNull();
  });

  it("connects through OAuth and refreshes an expired token", async () => {
    const { cookie, userId } = await seed({ repo: false, connected: false });
    const start = await call("/api/gitlab/connect", cookie);
    expect(start.status).toBe(303);
    const to = new URL(start.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("http://gitlab.test/oauth/authorize");
    expect(to.searchParams.get("redirect_uri")).toBe("http://localhost:5173/api/gitlab/callback");
    const state = to.searchParams.get("state")!;
    const stateCookie = `${cookie}; spectrace_gitlab_state=${state}`;
    expect((await call(`/api/gitlab/callback?code=good&state=nope`, stateCookie)).status).toBe(400);
    const back = await call(`/api/gitlab/callback?code=good&state=${state}`, stateCookie);
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe("/?gitlab=connected");
    expect(((await (await call("/api/gitlab", cookie)).json()) as { account: unknown }).account).toEqual({ username: "radu", kind: "oauth" });
    // Expire it: the next use refreshes first.
    await env.DB.prepare("UPDATE gitlab_connections SET expires_at = '2000-01-01T00:00:00Z' WHERE user_id = ?1").bind(userId).run();
    expect(await (await call("/api/gitlab/repos", cookie)).json()).toHaveLength(1);
    expect(sent.filter((s) => s.path === "/oauth/token")).toHaveLength(2);
    const row = await env.DB.prepare("SELECT expires_at FROM gitlab_connections WHERE user_id = ?1").bind(userId).first<{ expires_at: string }>();
    expect(Date.parse(row!.expires_at)).toBeGreaterThan(Date.now());
  });

  it("adds a GitLab repo to a project from its link, only when the account can reach it", async () => {
    const { cookie, projectId } = await seed({ repo: false });
    const add = (repo: string) => call(`/api/projects/${projectId}/repos`, cookie, { method: "POST", json: { repo } });
    expect((await add("http://gitlab.test/group/other")).status).toBe(403);
    const res = await add("http://gitlab.test/group/sub/shop");
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ provider: "gitlab", full_name: "group/sub/shop", github_repo_id: null, default_branch: "main" });
    expect((await add("http://gitlab.test/group/sub/shop.git")).status).toBe(409);
  });

  it("refuses a GitLab repo when no account is connected", async () => {
    const { cookie, projectId } = await seed({ repo: false, connected: false });
    const res = await call(`/api/projects/${projectId}/repos`, cookie, { method: "POST", json: { repo: "group/sub/shop", provider: "gitlab" } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe("Connect your GitLab account first, then add the repo again.");
  });
});

describe("GitLab sync and actions", () => {
  it("syncs open merge requests with their diffs, pipeline jobs and approvals", async () => {
    const { projectId, repoId } = await seed();
    merged = [mr(5, { state: "merged", merged_at: "2026-11-19T00:00:00Z" })];
    approvedBy = ["octo"];
    expect(await runJob(projectId, "sync", "")).toEqual({ state: "succeeded", error: null });
    const rows = (await env.DB.prepare("SELECT number, state, author_login, head_sha, additions, deletions, changed_files, merged_at, html_url FROM pull_requests WHERE repo_id = ?1 ORDER BY number").bind(repoId).all()).results;
    expect(rows).toEqual([
      { number: 5, state: "closed", author_login: "mona", head_sha: "sha5", additions: 0, deletions: 0, changed_files: 0, merged_at: "2026-11-19T00:00:00Z", html_url: "http://gitlab.test/group/sub/shop/-/merge_requests/5" },
      { number: 7, state: "open", author_login: "mona", head_sha: "sha7", additions: 3, deletions: 1, changed_files: 3, merged_at: null, html_url: "http://gitlab.test/group/sub/shop/-/merge_requests/7" },
    ]);
    const files = (await env.DB.prepare("SELECT f.path, f.status, f.previous_path, f.patch IS NOT NULL AS has_patch FROM pr_files f JOIN pull_requests p ON p.id = f.pull_request_id WHERE p.repo_id = ?1 ORDER BY f.path").bind(repoId).all()).results;
    expect(files).toEqual([
      { path: "a.png", status: "added", previous_path: null, has_patch: 0 },
      { path: "src/cart.rs", status: "modified", previous_path: null, has_patch: 1 },
      { path: "y.rs", status: "renamed", previous_path: "x.rs", has_patch: 1 },
    ]);
    const runs = (await env.DB.prepare("SELECT name, status, conclusion FROM pr_check_runs WHERE repo_id = ?1 ORDER BY name").bind(repoId).all()).results;
    expect(runs).toEqual([
      { name: "lint", status: "in_progress", conclusion: null },
      { name: "test", status: "completed", conclusion: "success" },
    ]);
    const approvals = (await env.DB.prepare("SELECT r.reviewer_login, r.commit_sha FROM pr_reviews r JOIN pull_requests p ON p.id = r.pull_request_id WHERE p.repo_id = ?1").bind(repoId).all()).results;
    expect(approvals).toEqual([{ reviewer_login: "octo", commit_sha: "sha7" }]);

    // Closed on GitLab since: marked closed, merged time from the MR.
    merged = [mr(7, { state: "merged", merged_at: "2026-11-23T00:00:00Z", updated_at: "2026-11-23T00:00:00Z" })];
    mrs = [];
    expect(await runJob(projectId, "sync", "")).toEqual({ state: "succeeded", error: null });
    expect(await env.DB.prepare("SELECT state, merged_at FROM pull_requests WHERE repo_id = ?1 AND number = 7").bind(repoId).first()).toEqual({ state: "closed", merged_at: "2026-11-23T00:00:00Z" });
  });

  it("fails the sync for good when the owner has no GitLab account", async () => {
    const { projectId } = await seed({ connected: false });
    const job = await runJob(projectId, "sync", "");
    expect(job?.state).toBe("failed");
    expect(job?.error).toContain("no GitLab account connected for group/sub/shop");
  });

  it("approves, requests changes and merges through GitLab", async () => {
    const { projectId, cookie } = await seed();
    await runJob(projectId, "sync", "");
    const pull = await env.DB.prepare("SELECT p.id FROM pull_requests p JOIN project_repos r ON r.id = p.repo_id WHERE r.project_id = ?1 AND p.number = 7").bind(projectId).first<{ id: string }>();
    const base = `/api/projects/${projectId}/pulls/${pull!.id}`;
    sent = [];
    expect((await call(`${base}/reviews`, cookie, { method: "POST", json: { verdict: "approve" } })).status).toBe(201);
    expect(sent).toEqual([{ method: "POST", path: `${API}/merge_requests/7/approve`, body: { sha: "sha7" } }]);
    sent = [];
    expect((await call(`${base}/reviews`, cookie, { method: "POST", json: { verdict: "request_changes", body: "Fix the cart" } })).status).toBe(201);
    expect(sent.map((s) => s.path)).toEqual([`${API}/merge_requests/7/unapprove`, `${API}/merge_requests/7/notes`]);
    expect(sent[1]!.body).toEqual({ body: "**Changes requested**\n\nFix the cart" });

    // Gates are the same as on GitHub; let them pass (an agent review, CI green, an approval).
    await env.DB.prepare("INSERT INTO reviews (id, pull_request_id, requested_by, head_sha, state) VALUES (?1, ?2, (SELECT owner_id FROM projects WHERE id = ?3), 'sha7', 'succeeded')").bind(`rv-${pull!.id}`, pull!.id, projectId).run();
    await env.DB.prepare("DELETE FROM pr_check_runs").run();
    await call(`${base}/reviews`, cookie, { method: "POST", json: { verdict: "approve" } });
    mergeStatus = 405;
    const refused = await call(`${base}/merge`, cookie, { method: "POST", json: { method: "squash" } });
    expect(await refused.json()).toEqual({ error: { code: "conflict", message: "conflict: Branch cannot be merged" } });
    mergeStatus = 200;
    sent = [];
    const ok = await call(`${base}/merge`, cookie, { method: "POST", json: { method: "squash" } });
    expect(ok.status).toBe(200);
    expect(sent).toEqual([{ method: "PUT", path: `${API}/merge_requests/7/merge`, body: { sha: "sha7", squash: true } }]);
  });
});

describe("GitLab webhook", () => {
  it("refuses a wrong token", async () => {
    expect((await hook("Push Hook", {}, "nope")).status).toBe(401);
    expect((await hook("Push Hook", {}, "")).status).toBe(401);
  });

  it("stores a merge request event, moves heads on push and stores pipeline jobs", async () => {
    const { repoId } = await seed();
    const opened = await hook("Merge Request Hook", { object_kind: "merge_request", project: { path_with_namespace: "group/sub/shop" }, object_attributes: { iid: 7, action: "open" } });
    expect(await opened.json()).toEqual({ ok: true, event: "Merge Request Hook", handled: true });
    expect(await env.DB.prepare("SELECT title, head_sha FROM pull_requests WHERE repo_id = ?1 AND number = 7").bind(repoId).first()).toEqual({ title: "MR 7", head_sha: "sha7" });

    await hook("Push Hook", { object_kind: "push", project: { path_with_namespace: "group/sub/shop" }, ref: "refs/heads/feat-7", before: "sha7", after: "sha8" });
    expect(await env.DB.prepare("SELECT head_sha FROM pull_requests WHERE repo_id = ?1 AND number = 7").bind(repoId).first()).toEqual({ head_sha: "sha8" });

    await hook("Pipeline Hook", {
      object_kind: "pipeline",
      project: { path_with_namespace: "group/sub/shop", web_url: "http://gitlab.test/group/sub/shop" },
      object_attributes: { id: 40, sha: "sha8", status: "failed" },
      builds: [{ id: 401, name: "test", status: "failed", started_at: "2026-11-26 10:00:00 UTC", finished_at: "2026-11-26 10:02:00 UTC" }],
    });
    expect(await env.DB.prepare("SELECT name, status, conclusion, html_url, completed_at FROM pr_check_runs WHERE repo_id = ?1 AND head_sha = 'sha8'").bind(repoId).first()).toEqual({
      name: "test",
      status: "completed",
      conclusion: "failure",
      html_url: "http://gitlab.test/group/sub/shop/-/jobs/401",
      completed_at: "2026-11-26T10:02:00.000Z",
    });
    const other = await hook("Note Hook", {});
    expect(await other.json()).toEqual({ ok: true, event: "Note Hook", handled: false });
  });
});

describe("GitLab index", () => {
  it("indexes the default branch's specs and adds the project's webhook once", async () => {
    const { projectId, repoId } = await seed();
    expect(await runJob(projectId, "index", repoId)).toEqual({ state: "succeeded", error: null });
    expect(await env.DB.prepare("SELECT index_state, file_count, head_sha, languages, github_repo_id FROM project_repos WHERE id = ?1").bind(repoId).first()).toEqual({
      index_state: "ready",
      file_count: Object.keys(SHOP).length,
      head_sha: "headsha",
      languages: '{"Rust":100}',
      github_repo_id: null,
    });
    expect((await env.DB.prepare("SELECT path FROM specs WHERE repo_id = ?1").bind(repoId).all()).results).toEqual([{ path: "spec/checkout.md" }]);
    expect(hooks).toEqual([expect.objectContaining({ url: "http://localhost:5173/api/gitlab/webhook", token: "glwh-test", merge_requests_events: true, push_events: true, pipeline_events: true })]);
    await runJob(projectId, "index", repoId);
    expect(hooks).toHaveLength(1);
  });
});
