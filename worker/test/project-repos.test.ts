import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "../src/auth";
import { forgetInstallationTokens } from "../src/github-app";
import { normalizeRepo } from "../src/routes/projects";

const BASE = "http://spectrace.test";

const gh = (owner: string, name: string, id: number, branch = "main") => ({
  id,
  name,
  full_name: `${owner}/${name}`,
  private: false,
  default_branch: branch,
  html_url: `https://github.example/${owner}/${name}`,
  owner: { login: owner },
});

/** A fake GitHub: installation 1001 can reach octocat/hello and octocat/Spoon; 9999 is gone. */
function mockGithub() {
  const real = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    if (url.origin !== "http://api.github.test") return real(input, init);
    const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
    if (mint) {
      if (mint[1] === "9999") return Response.json({}, { status: 404 });
      return Response.json({ token: `ghs_${mint[1]}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 });
    }
    if (url.pathname === "/installation/repositories") {
      return Response.json({ repositories: [gh("octocat", "hello", 1, "trunk"), gh("octocat", "Spoon", 2)] });
    }
    return Response.json({}, { status: 404 });
  });
}

async function userWithSession(githubId: number, login: string, installations: number[] = []): Promise<string> {
  const userId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO users (id, github_id, login) VALUES (?1, ?2, ?3)").bind(userId, githubId, login).run();
  const token = `token-${login}`;
  await env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(crypto.randomUUID(), userId, await hashToken(token), new Date(Date.now() + 86_400_000).toISOString())
    .run();
  for (const id of installations) {
    await env.DB.prepare("INSERT OR IGNORE INTO github_installations (id, account_id, account_login, account_type, repository_selection) VALUES (?1, ?1, 'x', 'User', 'all')").bind(id).run();
    await env.DB.prepare("INSERT INTO user_installations (user_id, installation_id) VALUES (?1, ?2)").bind(userId, id).run();
  }
  return `spectrace_session=${token}`;
}

async function call(method: string, path: string, cookie: string | null, body?: unknown) {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await exports.default.fetch(new Request(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const newProject = async (cookie: string) => (await call("POST", "/api/projects", cookie, { name: "Shop" })).body.id as string;
const add = (cookie: string | null, id: string, repo: string) => call("POST", `/api/projects/${id}/repos`, cookie, { repo });

beforeEach(async () => {
  forgetInstallationTokens();
  await env.DB.exec("DELETE FROM projects; DELETE FROM sessions; DELETE FROM github_installations; DELETE FROM users;");
});
afterEach(() => vi.restoreAllMocks());

describe("normalizeRepo", () => {
  it("reads owner/repo and GitHub links", () => {
    expect(normalizeRepo("  acme/shop ")).toBe("acme/shop");
    expect(normalizeRepo("https://github.com/acme/shop")).toBe("acme/shop");
    expect(normalizeRepo("http://www.github.com/acme/shop.git")).toBe("acme/shop");
    expect(normalizeRepo("github.com/acme/shop/")).toBe("acme/shop");
    expect(normalizeRepo("https://github.com/acme/shop/pull/3?x=1#y")).toBe("acme/shop");
    expect(normalizeRepo("acme/shop.git")).toBe("acme/shop");
    expect(normalizeRepo("")).toBe("");
    expect(normalizeRepo("acme")).toBe("acme");
    expect(normalizeRepo("a/b/c")).toBe("a/b/c");
    expect(normalizeRepo("https://github.com/acme")).toBe("acme");
  });
});

describe("add and remove repos", () => {
  it("adds owner/repo and a GitHub link, using GitHub's name, id and default branch", async () => {
    mockGithub();
    const me = await userWithSession(1, "octocat", [1001]);
    const id = await newProject(me);

    const a = await add(me, id, "octocat/hello");
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ full_name: "octocat/hello", github_repo_id: 1, default_branch: "trunk", index_state: "pending" });

    // A link, in another case: stored as GitHub spells it.
    const b = await add(me, id, "https://github.com/OCTOCAT/spoon.git");
    expect(b.status).toBe(201);
    expect(b.body.full_name).toBe("octocat/Spoon");

    const project = await call("GET", `/api/projects/${id}`, me);
    expect(project.body.repos.map((r: { full_name: string }) => r.full_name)).toEqual(["octocat/hello", "octocat/Spoon"]);
  });

  it("says 'Type a repo first' for an empty box", async () => {
    const me = await userWithSession(1, "octocat", [1001]);
    const id = await newProject(me);
    for (const empty of ["", "   "]) {
      const r = await add(me, id, empty);
      expect(r.status).toBe(400);
      expect(r.body.error).toEqual({ code: "bad_request", message: "Type a repo first, like owner/repo." });
    }
  });

  it("says 'does not look like owner/repo' for anything else", async () => {
    const spy = mockGithub();
    const me = await userWithSession(1, "octocat", [1001]);
    const id = await newProject(me);
    for (const bad of ["hello", "a/b/c", "not a repo", "https://github.com/octocat", "octocat/ he llo"]) {
      const r = await add(me, id, bad);
      expect(r.status, bad).toBe(400);
      expect(r.body.error.message, bad).toBe("That does not look like owner/repo.");
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a repo that is already in the project, however it is typed", async () => {
    const spy = mockGithub();
    const me = await userWithSession(1, "octocat", [1001]);
    const id = await newProject(me);
    await add(me, id, "octocat/hello");
    spy.mockClear();

    // The message names the repo as it was typed (links reduced to owner/repo), like the prototype.
    for (const [again, named] of [["octocat/hello", "octocat/hello"], ["OctoCat/Hello", "OctoCat/Hello"], ["https://github.com/octocat/hello", "octocat/hello"]] as const) {
      const r = await add(me, id, again);
      expect(r.status, again).toBe(409);
      expect(r.body.error).toEqual({ code: "conflict", message: `${named} is already in this project.` });
    }
    expect(spy).not.toHaveBeenCalled(); // no GitHub round trip for a duplicate
    expect((await call("GET", `/api/projects/${id}`, me)).body.repos).toHaveLength(1);
  });

  it("treats a renamed repo (same GitHub id) as a duplicate", async () => {
    mockGithub();
    const me = await userWithSession(1, "octocat", [1001]);
    const id = await newProject(me);
    await call("PATCH", `/api/projects/${id}`, me, { repos: [{ full_name: "octocat/old-name", github_repo_id: 1 }] });
    const r = await add(me, id, "octocat/hello");
    expect(r.status).toBe(409);
    expect(r.body.error.message).toBe("octocat/hello is already in this project.");
  });

  it("rejects a repo the GitHub App cannot reach", async () => {
    mockGithub();
    const me = await userWithSession(1, "octocat", [1001]);
    const noApp = await userWithSession(2, "mona");
    const id = await newProject(me);
    const other = await newProject(noApp);

    const outside = await add(me, id, "acme/private-thing");
    expect(outside.status).toBe(403);
    expect(outside.body.error.code).toBe("forbidden");
    expect(outside.body.error.message).toBe("acme/private-thing is not available to the GitHub App. Install the App on it, then add it again.");

    // Someone who never installed the App can add nothing, even a repo that others reach.
    expect((await add(noApp, other, "octocat/hello")).status).toBe(403);
    expect((await call("GET", `/api/projects/${id}`, me)).body.repos).toEqual([]);
  });

  it("forgets an uninstalled installation and then rejects its repos", async () => {
    mockGithub();
    const me = await userWithSession(1, "octocat", [9999]);
    const id = await newProject(me);
    expect((await add(me, id, "octocat/hello")).status).toBe(403);
  });

  it("allows at most 50 repos", async () => {
    mockGithub();
    const me = await userWithSession(1, "octocat", [1001]);
    const id = await newProject(me);
    await call("PATCH", `/api/projects/${id}`, me, { repos: Array.from({ length: 50 }, (_, i) => ({ full_name: `acme/r${i}` })) });
    const r = await add(me, id, "octocat/hello");
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain("at most 50");
  });

  it("removes a repo, and only from the owner's own project", async () => {
    mockGithub();
    const me = await userWithSession(1, "octocat", [1001]);
    const other = await userWithSession(2, "mona");
    const id = await newProject(me);
    const repoId = (await add(me, id, "octocat/hello")).body.id as string;

    expect((await call("DELETE", `/api/projects/${id}/repos/${repoId}`, other)).status).toBe(404);
    expect((await call("GET", `/api/projects/${id}`, me)).body.repos).toHaveLength(1);

    expect((await call("DELETE", `/api/projects/${id}/repos/${repoId}`, me)).status).toBe(204);
    expect((await call("GET", `/api/projects/${id}`, me)).body.repos).toEqual([]);
    expect((await call("DELETE", `/api/projects/${id}/repos/${repoId}`, me)).status).toBe(404);

    // It can be added again afterwards.
    expect((await add(me, id, "octocat/hello")).status).toBe(201);
  });

  it("needs a signed-in owner", async () => {
    mockGithub();
    const me = await userWithSession(1, "octocat", [1001]);
    const other = await userWithSession(2, "mona", [1001]);
    const id = await newProject(me);
    expect((await add(null, id, "octocat/hello")).status).toBe(401);
    expect((await add(other, id, "octocat/hello")).status).toBe(404);
    expect((await add(me, "no-such-project", "octocat/hello")).status).toBe(404);
    expect((await call("DELETE", `/api/projects/${id}/repos/x`, null)).status).toBe(401);
  });

  it("appears in the OpenAPI document", async () => {
    const doc = (await (await exports.default.fetch(new Request(`${BASE}/api/openapi.json`))).json()) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(["/api/projects/{id}/repos", "/api/projects/{id}/repos/{repoId}"]));
  });
});
