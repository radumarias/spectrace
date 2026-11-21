import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "../src/auth";
import { forgetInstallationTokens } from "../src/github-app";

// GitHub is never called: the API host is answered by a fake that records each write.
interface Sent {
  method: string;
  path: string;
  body: Record<string, unknown>;
}
let sent: Sent[];
/** Status and body the fake answers a review / merge with. */
let reviewReply: { status: number; json: Record<string, unknown> };
let mergeReply: { status: number; json: Record<string, unknown> };

function mockGithub() {
  const real = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    if (url.origin !== "http://api.github.test") return real(input, init);
    if (/^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) {
      return Response.json({ token: "ghs_test", expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 });
    }
    if (req.headers.get("authorization") !== "Bearer ghs_test") return Response.json({}, { status: 401 });
    sent.push({ method: req.method, path: url.pathname, body: (await req.json()) as Record<string, unknown> });
    const reply = url.pathname.endsWith("/merge") ? mergeReply : reviewReply;
    return Response.json(reply.json, { status: reply.status });
  });
}

let n = 0;
async function seed(opts: { draft?: number; state?: string; installation?: boolean } = {}) {
  const login = `actions-${++n}-${crypto.randomUUID().slice(0, 8)}`;
  const userId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO users (id, github_id, login) VALUES (?1, ?2, ?3)").bind(userId, 4_000_000 + n, login).run();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(crypto.randomUUID(), userId, await hashToken(login), new Date(Date.now() + 86_400_000).toISOString())
    .run();
  const projectId = `proj-${userId}`;
  await env.DB.prepare("INSERT INTO projects (id, owner_id, name) VALUES (?1, ?2, 'p')").bind(projectId, userId).run();
  const repoId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO project_repos (id, project_id, full_name) VALUES (?1, ?2, 'acme/shop')").bind(repoId, projectId).run();
  if (opts.installation !== false) {
    const instId = 7000 + n;
    await env.DB.prepare("INSERT INTO github_installations (id, account_id, account_login, account_type, repository_selection) VALUES (?1, 1, 'Acme', 'Organization', 'all')").bind(instId).run();
    await env.DB.prepare("INSERT INTO user_installations (user_id, installation_id) VALUES (?1, ?2)").bind(userId, instId).run();
  }
  const pullId = `pr-${repoId}`;
  await env.DB.prepare(
    `INSERT INTO pull_requests (id, repo_id, number, github_pr_id, title, author_login, state, draft, head_ref, head_sha, base_ref, html_url, github_created_at, github_updated_at)
     VALUES (?1, ?2, 7, ?3, 'Add checkout', 'mona', ?4, ?5, 'feat', 'sha1', 'main', 'https://github.com/acme/shop/pull/7', '2026-11-01T00:00:00Z', '2026-11-10T00:00:00Z')`,
  )
    .bind(pullId, repoId, 20_000 + n, opts.state ?? "open", opts.draft ?? 0)
    .run();
  return { userId, cookie: `spectrace_session=${login}`, projectId, pullId, base: `/api/projects/${projectId}/pulls/${pullId}` };
}
type Seed = Awaited<ReturnType<typeof seed>>;

const call = (path: string, cookie: string | null, init: RequestInit & { json?: unknown } = {}) => {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    init = { ...init, body: JSON.stringify(init.json) };
  }
  return exports.default.fetch(new Request(`http://spectrace.test${path}`, { ...init, headers }));
};
const post = (s: Seed, tail: string, json?: unknown) => call(`${s.base}${tail}`, s.cookie, { method: "POST", json });
const needs = async (s: Seed) => ((await (await call(`/api/projects/${s.projectId}/pulls?filter=needs`, s.cookie)).json()) as { pulls: unknown[]; counts: { needs: number } });

let spy: ReturnType<typeof mockGithub>;
beforeEach(() => {
  sent = [];
  reviewReply = { status: 200, json: { id: 555 } };
  mergeReply = { status: 200, json: { merged: true, sha: "m1" } };
  spy = mockGithub();
});
afterEach(() => {
  spy.mockRestore();
  forgetInstallationTokens();
});

describe("POST .../reviews", () => {
  it("approves on GitHub at the head commit, records it, and takes the PR out of needs", async () => {
    const s = await seed();
    expect((await needs(s)).counts.needs).toBe(1);
    const res = await post(s, "/reviews", { verdict: "approve" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ verdict: "approved", body: "", headSha: "sha1", githubReviewId: 555 });
    expect(sent).toEqual([{ method: "POST", path: "/repos/acme/shop/pulls/7/reviews", body: { commit_id: "sha1", event: "APPROVE" } }]);
    const after = await needs(s);
    expect(after.pulls).toHaveLength(0);
    expect(after.counts.needs).toBe(0);
    const detail = (await (await call(s.base, s.cookie)).json()) as { needsYou: boolean };
    expect(detail.needsYou).toBe(false);
    const list = (await (await call(`${s.base}/reviews`, s.cookie)).json()) as { reviews: unknown[] };
    expect(list.reviews).toHaveLength(1);
  });

  it("a push after the approval brings the PR back, and so does a later request for changes", async () => {
    const s = await seed();
    await post(s, "/reviews", { verdict: "approve" });
    await env.DB.prepare("UPDATE pull_requests SET head_sha = 'sha2' WHERE id = ?1").bind(s.pullId).run();
    expect((await needs(s)).counts.needs).toBe(1);
    await post(s, "/reviews", { verdict: "approve" });
    expect((await needs(s)).counts.needs).toBe(0);
    expect((await post(s, "/reviews", { verdict: "request_changes", body: "Please add a test." })).status).toBe(201);
    expect(sent.at(-1)?.body).toEqual({ commit_id: "sha2", event: "REQUEST_CHANGES", body: "Please add a test." });
    expect((await needs(s)).counts.needs).toBe(1);
  });

  it("another user's approval does not hide the PR from you", async () => {
    const s = await seed();
    const other = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO users (id, github_id, login) VALUES (?1, 4999999, 'other-user')").bind(other).run();
    await env.DB.prepare("INSERT INTO pull_reviews (pull_request_id, user_id, verdict, head_sha) VALUES (?1, ?2, 'approved', 'sha1')").bind(s.pullId, other).run();
    expect((await needs(s)).counts.needs).toBe(1);
  });

  it("requesting changes needs a comment, and nothing is sent without one", async () => {
    const s = await seed();
    expect((await post(s, "/reviews", { verdict: "request_changes", body: "  " })).status).toBe(400);
    expect((await post(s, "/reviews", { verdict: "nope" })).status).toBe(400);
    expect(sent).toEqual([]);
  });

  it("refuses closed, merged and unknown PRs; keeps other users out; needs sign-in", async () => {
    const closed = await seed({ state: "closed" });
    expect((await post(closed, "/reviews", { verdict: "approve" })).status).toBe(409);
    const s = await seed();
    const stranger = await seed();
    expect((await call(`${s.base}/reviews`, stranger.cookie, { method: "POST", json: { verdict: "approve" } })).status).toBe(404);
    expect((await call(`/api/projects/${s.projectId}/pulls/nope/reviews`, s.cookie, { method: "POST", json: { verdict: "approve" } })).status).toBe(404);
    expect((await call(`${s.base}/reviews`, null, { method: "POST", json: { verdict: "approve" } })).status).toBe(401);
    expect(sent).toEqual([]);
  });

  it("records nothing when GitHub refuses (422) or fails (500)", async () => {
    const s = await seed();
    reviewReply = { status: 422, json: { message: "Can not approve your own pull request" } };
    const refused = await post(s, "/reviews", { verdict: "approve" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: { code: "conflict", message: "conflict: Can not approve your own pull request" } });
    reviewReply = { status: 500, json: {} };
    expect((await post(s, "/reviews", { verdict: "approve" })).status).toBe(502);
    expect(((await (await call(`${s.base}/reviews`, s.cookie)).json()) as { reviews: unknown[] }).reviews).toEqual([]);
  });

  it("says so when the app is not installed on the repo's owner", async () => {
    const s = await seed({ installation: false });
    expect((await post(s, "/reviews", { verdict: "approve" })).status).toBe(409);
  });
});

describe("POST .../merge", () => {
  it("squash-merges at the head commit and moves the PR to Merged", async () => {
    const s = await seed();
    const res = await post(s, "/merge");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: s.pullId, state: "merged", needsYou: false });
    expect(sent).toEqual([{ method: "PUT", path: "/repos/acme/shop/pulls/7/merge", body: { merge_method: "squash", sha: "sha1" } }]);
    const merged = (await (await call(`/api/projects/${s.projectId}/pulls?filter=merged`, s.cookie)).json()) as { pulls: { number: number }[] };
    expect(merged.pulls.map((p) => p.number)).toEqual([7]);
    expect((await needs(s)).counts.needs).toBe(0);
  });

  it("uses the method asked for", async () => {
    const s = await seed();
    expect((await post(s, "/merge", { method: "rebase" })).status).toBe(200);
    expect(sent[0]?.body).toMatchObject({ merge_method: "rebase" });
    expect((await post(await seed(), "/merge", { method: "fast-forward" })).status).toBe(400);
  });

  it("refuses drafts and PRs that are not open without calling GitHub", async () => {
    expect((await post(await seed({ draft: 1 }), "/merge")).status).toBe(409);
    const s = await seed();
    await post(s, "/merge");
    sent = [];
    expect((await post(s, "/merge")).status).toBe(409);
    expect(sent).toEqual([]);
  });

  it("leaves the PR open when GitHub says it is not mergeable (405) or the head moved (409)", async () => {
    const s = await seed();
    mergeReply = { status: 405, json: { message: "Required status check is expected" } };
    const res = await post(s, "/merge");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "conflict", message: "conflict: Required status check is expected" } });
    mergeReply = { status: 409, json: { message: "Head branch was modified" } };
    expect((await post(s, "/merge")).status).toBe(409);
    expect((await needs(s)).counts.needs).toBe(1);
  });

  it("502 on a GitHub outage; 401 without a session; 404 for someone else's project", async () => {
    const s = await seed();
    mergeReply = { status: 503, json: {} };
    expect((await post(s, "/merge")).status).toBe(502);
    expect((await call(`${s.base}/merge`, null, { method: "POST" })).status).toBe(401);
    expect((await call(`${s.base}/merge`, (await seed()).cookie, { method: "POST" })).status).toBe(404);
  });
});
