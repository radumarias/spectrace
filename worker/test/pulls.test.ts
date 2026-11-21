import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { hashToken } from "../src/auth";

let n = 0;

interface Seed {
  userId: string;
  cookie: string;
  projectId: string;
  shop: string;
  api: string;
}

const call = (path: string, cookie: string | null, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  return exports.default.fetch(new Request(`http://spectrace.test${path}`, { ...init, headers }));
};

async function newUser() {
  const login = `pulls-${++n}-${crypto.randomUUID().slice(0, 8)}`;
  const userId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO users (id, github_id, login) VALUES (?1, ?2, ?3)").bind(userId, 3_000_000 + n, login).run();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(crypto.randomUUID(), userId, await hashToken(login), new Date(Date.now() + 86_400_000).toISOString())
    .run();
  return { userId, cookie: `spectrace_session=${login}` };
}

async function addPull(repoId: string, num: number, o: { state?: string; draft?: number; merged?: string | null; updated?: string; title?: string } = {}) {
  const id = `pr-${repoId}-${num}`;
  await env.DB.prepare(
    `INSERT INTO pull_requests (id, repo_id, number, github_pr_id, title, body, author_login, state, draft, head_ref, head_sha, base_ref, html_url,
       additions, deletions, changed_files, github_created_at, github_updated_at, merged_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'the body', 'mona', ?6, ?7, 'feat', 'sha', 'main', ?8, 5, 1, 1, '2026-11-01T00:00:00Z', ?9, ?10)`,
  )
    .bind(id, repoId, num, 10_000 + n++, o.title ?? `PR ${num}`, o.state ?? "open", o.draft ?? 0, `https://github.com/x/y/pull/${num}`, o.updated ?? "2026-11-10T00:00:00Z", o.merged ?? null)
    .run();
  return id;
}

/** A project with two repos: shop has #1 open, #2 open (newer), #3 draft, #4 merged, #5 closed unmerged; api has #1 open and #2 merged. */
async function seed(): Promise<Seed> {
  const { userId, cookie } = await newUser();
  const projectId = `proj-${userId}`;
  await env.DB.prepare("INSERT INTO projects (id, owner_id, name) VALUES (?1, ?2, 'p')").bind(projectId, userId).run();
  const shop = crypto.randomUUID();
  const api = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO project_repos (id, project_id, full_name) VALUES (?1, ?2, 'acme/shop'), (?3, ?2, 'acme/api')").bind(shop, projectId, api).run();
  await addPull(shop, 1, { updated: "2026-11-10T00:00:00Z" });
  await addPull(shop, 2, { updated: "2026-11-12T00:00:00Z" });
  await addPull(shop, 3, { draft: 1, updated: "2026-11-13T00:00:00Z" });
  await addPull(shop, 4, { state: "closed", merged: "2026-11-09T00:00:00Z", updated: "2026-11-09T00:00:00Z" });
  await addPull(shop, 5, { state: "closed" });
  await addPull(api, 1, { updated: "2026-11-11T00:00:00Z" });
  await addPull(api, 2, { state: "closed", merged: "2026-11-08T00:00:00Z", updated: "2026-11-08T00:00:00Z" });
  return { userId, cookie, projectId, shop, api };
}

const ids = (body: { pulls: { repo: string; number: number }[] }) => body.pulls.map((p) => `${p.repo.split("/")[1]}#${p.number}`);
const list = async (s: Seed, query = "") => {
  const res = await call(`/api/projects/${s.projectId}/pulls${query}`, s.cookie);
  expect(res.status).toBe(200);
  return (await res.json()) as { pulls: { id: string; repo: string; number: number; state: string; needsYou: boolean; draft: boolean }[]; counts: { needs: number; open: number; merged: number } };
};

describe("GET /api/projects/{id}/pulls", () => {
  it("counts the latest check run of each name on the head commit", async () => {
    const s = await seed();
    const run = (rid: number, name: string, status: string, conclusion: string | null) =>
      env.DB.prepare("INSERT INTO pr_check_runs (repo_id, github_check_run_id, head_sha, name, status, conclusion) VALUES (?1, ?2, 'sha', ?3, ?4, ?5)").bind(s.shop, rid, name, status, conclusion);
    await env.DB.batch([
      run(1, "build", "completed", "success"),
      run(2, "test", "completed", "failure"),
      run(3, "test", "completed", "success"), // re-run replaces the failure
      run(4, "lint", "completed", "failure"),
      run(5, "deploy", "in_progress", null),
    ]);
    const body = await list(s);
    expect(body.pulls.find((p) => p.repo === "acme/shop" && p.number === 1)).toMatchObject({ testsTotal: 4, testsPassed: 2, testsFailed: 1 });
    expect(body.pulls.find((p) => p.repo === "acme/api" && p.number === 1)).toMatchObject({ testsTotal: 0, testsPassed: 0, testsFailed: 0 });
  });

  it("filter=needs: open, not draft; most recently updated first", async () => {
    const s = await seed();
    const body = await list(s, "?filter=needs");
    expect(ids(body)).toEqual(["shop#2", "api#1", "shop#1"]);
    expect(body.pulls.every((p) => p.needsYou && p.state === "open")).toBe(true);
  });

  it("filter=open: every open PR including drafts, needs-you ones first", async () => {
    const s = await seed();
    const body = await list(s, "?filter=open");
    expect(ids(body)).toEqual(["shop#2", "api#1", "shop#1", "shop#3"]);
    expect(body.pulls.find((p) => p.number === 3 && p.repo === "acme/shop")).toMatchObject({ draft: true, needsYou: false, state: "open" });
  });

  it("filter=merged: only PRs with a merge time, reported as merged", async () => {
    const s = await seed();
    const body = await list(s, "?filter=merged");
    expect(ids(body)).toEqual(["shop#4", "api#2"]);
    expect(body.pulls.map((p) => p.state)).toEqual(["merged", "merged"]);
  });

  it("filter=all (the default) also lists PRs closed without merging", async () => {
    const s = await seed();
    const body = await list(s);
    expect(body.pulls).toHaveLength(7);
    expect(body.pulls.find((p) => p.number === 5 && p.repo === "acme/shop")?.state).toBe("closed");
    expect(await list(s, "?filter=all")).toEqual(body);
  });

  it("repo narrows every filter, and counts still cover the whole project", async () => {
    const s = await seed();
    expect(ids(await list(s, "?filter=needs&repo=acme/api"))).toEqual(["api#1"]);
    expect(ids(await list(s, "?filter=open&repo=acme/shop"))).toEqual(["shop#2", "shop#1", "shop#3"]);
    expect(ids(await list(s, "?filter=merged&repo=ACME/API"))).toEqual(["api#2"]); // case-insensitive, like GitHub
    expect(ids(await list(s, "?repo=acme/nope"))).toEqual([]);
    expect((await list(s, "?filter=needs&repo=acme/api")).counts).toEqual({ needs: 3, open: 4, merged: 2 });
  });

  it("counts match each tab", async () => {
    const s = await seed();
    const body = await list(s);
    expect(body.counts).toEqual({ needs: 3, open: 4, merged: 2 });
    for (const [filter, count] of Object.entries(body.counts)) expect((await list(s, `?filter=${filter}`)).pulls).toHaveLength(count);
  });

  it("counts are zero for a project with no pull requests", async () => {
    const { userId, cookie } = await newUser();
    await env.DB.prepare("INSERT INTO projects (id, owner_id, name) VALUES (?1, ?2, 'empty')").bind(`proj-${userId}`, userId).run();
    const res = await call(`/api/projects/proj-${userId}/pulls?filter=needs`, cookie);
    expect(await res.json()).toEqual({ pulls: [], counts: { needs: 0, open: 0, merged: 0 } });
  });

  it("limit caps the list, not the counts", async () => {
    const s = await seed();
    const body = await list(s, "?limit=2");
    expect(body.pulls).toHaveLength(2);
    expect(body.counts.open).toBe(4);
  });

  it("returns the fields the inbox shows", async () => {
    const s = await seed();
    const body = await list(s, "?filter=merged&repo=acme/api");
    expect(body.pulls[0]).toEqual({
      id: `pr-${s.api}-2`,
      repo: "acme/api",
      number: 2,
      title: "PR 2",
      author: "mona",
      state: "merged",
      draft: false,
      needsYou: false,
      headRef: "feat",
      baseRef: "main",
      htmlUrl: "https://github.com/x/y/pull/2",
      additions: 5,
      deletions: 1,
      changedFiles: 1,
      createdAt: "2026-11-01T00:00:00Z",
      updatedAt: "2026-11-08T00:00:00Z",
      mergedAt: "2026-11-08T00:00:00Z",
      syncedAt: expect.any(String),
      testsTotal: 0,
      testsPassed: 0,
      testsFailed: 0,
    });
  });

  it("rejects an unknown filter and a bad limit", async () => {
    const s = await seed();
    for (const q of ["?filter=risky", "?limit=0", "?limit=500"]) {
      const res = await call(`/api/projects/${s.projectId}/pulls${q}`, s.cookie);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "bad_request" } });
    }
  });

  it("needs a session and the project's owner; other projects' PRs never leak", async () => {
    const s = await seed();
    expect((await call(`/api/projects/${s.projectId}/pulls`, null)).status).toBe(401);
    const other = await newUser();
    const res = await call(`/api/projects/${s.projectId}/pulls`, other.cookie);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("GET /api/projects/{id}/pulls/{pullId}", () => {
  it("returns the header, description and changed files", async () => {
    const s = await seed();
    const id = `pr-${s.shop}-1`;
    await env.DB.prepare(
      "INSERT INTO pr_files (pull_request_id, path, status, previous_path, additions, deletions) VALUES (?1, 'src/b.ts', 'renamed', 'src/a.ts', 3, 3), (?1, 'src/a2.ts', 'added', NULL, 2, 0)",
    )
      .bind(id)
      .run();
    const res = await call(`/api/projects/${s.projectId}/pulls/${id}`, s.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id,
      repo: "acme/shop",
      number: 1,
      state: "open",
      needsYou: true,
      body: "the body",
      headSha: "sha",
      files: [
        { path: "src/a2.ts", status: "added", previousPath: null, additions: 2, deletions: 0 },
        { path: "src/b.ts", status: "renamed", previousPath: "src/a.ts", additions: 3, deletions: 3 },
      ],
    });
  });

  it("serves the diff of each file apart from the pull request", async () => {
    const s = await seed();
    const id = `pr-${s.shop}-1`;
    await env.DB.prepare("INSERT INTO pr_files (pull_request_id, path, status, additions, deletions, patch) VALUES (?1, 'b.ts', 'modified', 1, 1, '@@ -1 +1 @@\n-a\n+b'), (?1, 'a.png', 'added', 0, 0, NULL)")
      .bind(id)
      .run();
    const res = await call(`/api/projects/${s.projectId}/pulls/${id}/diff`, s.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ files: [{ path: "a.png", patch: null }, { path: "b.ts", patch: "@@ -1 +1 @@\n-a\n+b" }] });
    const detail = (await (await call(`/api/projects/${s.projectId}/pulls/${id}`, s.cookie)).json()) as { files: object[] };
    expect(JSON.stringify(detail.files)).not.toContain("patch");
    const t = await seed();
    expect((await call(`/api/projects/${s.projectId}/pulls/pr-${t.shop}-1/diff`, s.cookie)).status).toBe(404);
    expect((await call(`/api/projects/${s.projectId}/pulls/${id}/diff`, null)).status).toBe(401);
  });

  it("lists the check runs of the head commit, failures first, with one run per name", async () => {
    const s = await seed();
    const id = `pr-${s.shop}-1`;
    const repo = (await env.DB.prepare("SELECT repo_id FROM pull_requests WHERE id = ?1").bind(id).first<{ repo_id: string }>())!.repo_id;
    const run = (rid: number, name: string, status: string, conclusion: string | null, sha = "sha") =>
      env.DB.prepare("INSERT INTO pr_check_runs (repo_id, github_check_run_id, head_sha, name, status, conclusion, html_url) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'https://x/' || ?2)").bind(repo, rid, sha, name, status, conclusion);
    await env.DB.batch([
      run(1, "build", "completed", "success"),
      run(2, "test", "completed", "failure"),
      run(3, "test", "completed", "success"), // a re-run of "test" replaces the failed one
      run(4, "deploy", "in_progress", null),
      run(5, "lint", "completed", "failure"),
      run(6, "old", "completed", "failure", "other-sha"),
    ]);
    const body = (await (await call(`/api/projects/${s.projectId}/pulls/${id}`, s.cookie)).json()) as { checks: { name: string }[]; checksState: string };
    expect(body.checks.map((c) => c.name)).toEqual(["lint", "deploy", "build", "test"]);
    expect(body.checksState).toBe("failing");
    await env.DB.prepare("DELETE FROM pr_check_runs WHERE name = 'lint'").run();
    expect(((await (await call(`/api/projects/${s.projectId}/pulls/${id}`, s.cookie)).json()) as { checksState: string }).checksState).toBe("pending");
  });

  it("says there are no checks when none are stored", async () => {
    const s = await seed();
    const body = (await (await call(`/api/projects/${s.projectId}/pulls/pr-${s.shop}-1`, s.cookie)).json()) as { checks: unknown[]; checksState: string };
    expect(body).toMatchObject({ checks: [], checksState: "none" });
  });

  it("is 404 for an unknown PR, a PR of another project, and a stranger", async () => {
    const s = await seed();
    const t = await seed();
    expect((await call(`/api/projects/${s.projectId}/pulls/nope`, s.cookie)).status).toBe(404);
    expect((await call(`/api/projects/${s.projectId}/pulls/pr-${t.shop}-1`, s.cookie)).status).toBe(404);
    expect((await call(`/api/projects/${s.projectId}/pulls/pr-${s.shop}-1`, t.cookie)).status).toBe(404);
    expect((await call(`/api/projects/${s.projectId}/pulls/pr-${s.shop}-1`, null)).status).toBe(401);
  });
});

describe("POST /api/projects/{id}/pulls/sync (Pull from GitHub)", () => {
  const sync = (s: Seed, body?: unknown, cookie: string | null = s.cookie) =>
    call(`/api/projects/${s.projectId}/pulls/sync`, cookie, body === undefined ? { method: "POST" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("queues a sync job for every repo of the project", async () => {
    const s = await seed();
    const res = await sync(s);
    expect(res.status).toBe(202);
    const job = (await res.json()) as { id: string; kind: string; target: string; state: string };
    expect(job).toMatchObject({ kind: "sync", target: "", state: "queued" });
    expect(await env.DB.prepare("SELECT kind, target, state FROM jobs WHERE id = ?1").bind(job.id).first()).toEqual({ kind: "sync", target: "", state: "queued" });
  });

  it("can target one repo, using the stored spelling of its name", async () => {
    const s = await seed();
    const res = await sync(s, { repo: "ACME/api" });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ kind: "sync", target: "acme/api" });
  });

  it("returns the job already queued instead of a second one", async () => {
    const s = await seed();
    const a = (await (await sync(s)).json()) as { id: string };
    const b = (await (await sync(s)).json()) as { id: string };
    expect(b.id).toBe(a.id);
    const other = (await (await sync(s, { repo: "acme/shop" })).json()) as { id: string };
    expect(other.id).not.toBe(a.id);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE project_id = ?1").bind(s.projectId).first<{ n: number }>())?.n).toBe(2);
  });

  it("queues again once the earlier sync has finished or gone stale", async () => {
    const s = await seed();
    const a = (await (await sync(s)).json()) as { id: string };
    await env.DB.prepare("UPDATE jobs SET state = 'succeeded' WHERE id = ?1").bind(a.id).run();
    const b = (await (await sync(s)).json()) as { id: string };
    expect(b.id).not.toBe(a.id);
    await env.DB.prepare("UPDATE jobs SET state = 'running', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour') WHERE id = ?1").bind(b.id).run();
    const c = (await (await sync(s)).json()) as { id: string };
    expect(c.id).not.toBe(b.id);
  });

  it("is 404 for a repo that is not the project's", async () => {
    const s = await seed();
    const res = await sync(s, { repo: "acme/other" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("needs a session and the project's owner", async () => {
    const s = await seed();
    expect((await sync(s, undefined, null)).status).toBe(401);
    expect((await sync(s, undefined, (await newUser()).cookie)).status).toBe(404);
  });
});
