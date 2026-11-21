import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { hashToken } from "../src/auth";

const BASE = "http://spectrace.test";

/** A user with a live session; returns the cookie header for them. */
async function userWithSession(githubId: number, login: string): Promise<string> {
  const userId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO users (id, github_id, login) VALUES (?1, ?2, ?3)").bind(userId, githubId, login).run();
  const token = `token-${login}`;
  await env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(crypto.randomUUID(), userId, await hashToken(token), new Date(Date.now() + 86_400_000).toISOString())
    .run();
  return `spectrace_session=${token}`;
}

async function call(method: string, path: string, cookie: string | null, body?: unknown) {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await exports.default.fetch(
    new Request(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM projects; DELETE FROM sessions; DELETE FROM users;");
});

describe("projects API", () => {
  it("creates and reads a project", async () => {
    const alice = await userWithSession(1, "alice");
    const created = await call("POST", "/api/projects", alice, {
      name: "  Shop  ",
      context: "Checkout flow lives in the shop app.",
      repos: [{ full_name: "acme/shop", github_repo_id: 42, default_branch: "trunk" }, { full_name: "acme/infra" }],
    });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe("Shop");
    expect(created.body.context).toBe("Checkout flow lives in the shop app.");
    expect(created.body.repos).toHaveLength(2);
    const shop = created.body.repos.find((r: { full_name: string }) => r.full_name === "acme/shop");
    expect(shop).toMatchObject({ github_repo_id: 42, default_branch: "trunk", index_state: "pending" });
    const infra = created.body.repos.find((r: { full_name: string }) => r.full_name === "acme/infra");
    expect(infra).toMatchObject({ default_branch: "main", github_repo_id: null });
    expect(infra).not.toHaveProperty("project_id");

    const read = await call("GET", `/api/projects/${created.body.id}`, alice);
    expect(read.status).toBe(200);
    expect(read.body).toEqual(created.body);
  });

  it("creates a project without repos or context", async () => {
    const alice = await userWithSession(1, "alice");
    const { status, body } = await call("POST", "/api/projects", alice, { name: "Bare" });
    expect(status).toBe(201);
    expect(body.context).toBe("");
    expect(body.repos).toEqual([]);
  });

  it("validates input", async () => {
    const alice = await userWithSession(1, "alice");
    const bad = async (payload: unknown) => {
      const res = await call("POST", "/api/projects", alice, payload);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("bad_request");
    };
    await bad({});
    await bad({ name: "   " });
    await bad({ name: "x".repeat(121) });
    await bad({ name: "ok", context: "x".repeat(20_001) });
    await bad({ name: "ok", repos: [{ full_name: "no-slash" }] });
    await bad({ name: "ok", repos: [{ full_name: "a/b/c" }] });
    await bad({ name: "ok", repos: [{ full_name: "a b/c" }] });
    await bad({ name: "ok", repos: [{ full_name: "acme/shop" }, { full_name: "ACME/Shop" }] });
    await bad({ name: "ok", repos: [{ full_name: "acme/shop", default_branch: " " }] });
    await bad({ name: "ok", repos: Array.from({ length: 51 }, (_, i) => ({ full_name: `acme/r${i}` })) });
    expect((await call("GET", "/api/projects", alice)).body).toEqual([]);
  });

  it("lists only my projects, with their repos", async () => {
    const alice = await userWithSession(1, "alice");
    const bob = await userWithSession(2, "bob");
    await call("POST", "/api/projects", alice, { name: "A1", repos: [{ full_name: "acme/one" }] });
    await call("POST", "/api/projects", alice, { name: "A2", repos: [{ full_name: "acme/two" }, { full_name: "acme/three" }] });
    await call("POST", "/api/projects", bob, { name: "B1", repos: [{ full_name: "bob/secret" }] });

    const mine = await call("GET", "/api/projects", alice);
    expect(mine.status).toBe(200);
    expect(mine.body.map((p: { name: string }) => p.name)).toEqual(["A1", "A2"]);
    expect(mine.body[0].repos.map((r: { full_name: string }) => r.full_name)).toEqual(["acme/one"]);
    expect(mine.body[1].repos.map((r: { full_name: string }) => r.full_name).sort()).toEqual(["acme/three", "acme/two"]);

    const theirs = await call("GET", "/api/projects", bob);
    expect(theirs.body.map((p: { name: string }) => p.name)).toEqual(["B1"]);
  });

  it("update changes only what is sent and keeps ids of repos that stay", async () => {
    const alice = await userWithSession(1, "alice");
    const { body: p } = await call("POST", "/api/projects", alice, {
      name: "Shop",
      context: "old",
      repos: [{ full_name: "acme/shop", github_repo_id: 42, default_branch: "trunk" }, { full_name: "acme/infra" }],
    });
    const url = `/api/projects/${p.id}`;
    const shopId = p.repos.find((r: { full_name: string }) => r.full_name === "acme/shop").id;
    await env.DB.prepare("UPDATE project_repos SET index_state = 'ready' WHERE id = ?1").bind(shopId).run();

    const renamed = await call("PATCH", url, alice, { name: "Store" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe("Store");
    expect(renamed.body.context).toBe("old");
    expect(renamed.body.repos).toHaveLength(2);

    const ctx = await call("PATCH", url, alice, { context: "" });
    expect(ctx.body.context).toBe("");
    expect(ctx.body.name).toBe("Store");

    // Replace the repo list: shop stays (case-insensitive match keeps id and index state), infra goes, docs is new.
    const replaced = await call("PATCH", url, alice, { repos: [{ full_name: "acme/Shop" }, { full_name: "acme/docs", default_branch: "dev" }] });
    expect(replaced.status).toBe(200);
    expect(replaced.body.repos).toHaveLength(2);
    const shop = replaced.body.repos.find((r: { id: string }) => r.id === shopId);
    expect(shop).toMatchObject({ github_repo_id: 42, default_branch: "trunk", index_state: "ready" });
    expect(replaced.body.repos.find((r: { full_name: string }) => r.full_name === "acme/docs").default_branch).toBe("dev");

    const cleared = await call("PATCH", url, alice, { repos: [] });
    expect(cleared.body.repos).toEqual([]);
    expect(cleared.body.name).toBe("Store");
    expect(cleared.body.updated_at >= p.updated_at).toBe(true);

    expect((await call("PATCH", url, alice, { name: "" })).status).toBe(400);
    expect((await call("PATCH", url, alice, { repos: [{ full_name: "nope" }] })).status).toBe(400);
    expect((await call("GET", url, alice)).body.name).toBe("Store");
  });

  it("delete removes the project and its repos", async () => {
    const alice = await userWithSession(1, "alice");
    const { body: p } = await call("POST", "/api/projects", alice, { name: "Gone", repos: [{ full_name: "acme/shop" }] });
    const del = await call("DELETE", `/api/projects/${p.id}`, alice);
    expect(del.status).toBe(204);
    expect((await call("GET", `/api/projects/${p.id}`, alice)).status).toBe(404);
    expect((await call("DELETE", `/api/projects/${p.id}`, alice)).status).toBe(404);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM project_repos").first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("only the owner can see or change a project; others get 404", async () => {
    const alice = await userWithSession(1, "alice");
    const bob = await userWithSession(2, "bob");
    const { body: p } = await call("POST", "/api/projects", alice, { name: "Private", repos: [{ full_name: "acme/shop" }] });
    const url = `/api/projects/${p.id}`;

    for (const [method, body] of [["GET"], ["PATCH", { name: "Hacked" }], ["DELETE"]] as const) {
      const res = await call(method, url, bob, body);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("not_found");
    }
    const missing = await call("GET", `/api/projects/${crypto.randomUUID()}`, alice);
    expect(missing.status).toBe(404);

    const still = await call("GET", url, alice);
    expect(still.body.name).toBe("Private");
    expect(still.body.repos).toHaveLength(1);
  });

  it("every call needs a signed-in user", async () => {
    const alice = await userWithSession(1, "alice");
    const { body: p } = await call("POST", "/api/projects", alice, { name: "Mine" });
    const url = `/api/projects/${p.id}`;
    for (const [method, path, body] of [
      ["GET", "/api/projects"],
      ["POST", "/api/projects", { name: "x" }],
      ["GET", url],
      ["PATCH", url, { name: "x" }],
      ["DELETE", url],
    ] as const) {
      expect((await call(method, path, null, body)).status).toBe(401);
      expect((await call(method, path, "spectrace_session=garbage", body)).status).toBe(401);
    }
    expect((await call("GET", url, alice)).body.name).toBe("Mine");
  });

  it("deleting a user deletes their projects", async () => {
    const alice = await userWithSession(1, "alice");
    await call("POST", "/api/projects", alice, { name: "Mine", repos: [{ full_name: "acme/shop" }] });
    await env.DB.exec("DELETE FROM users");
    const projects = await env.DB.prepare("SELECT COUNT(*) AS n FROM projects").first<{ n: number }>();
    const repos = await env.DB.prepare("SELECT COUNT(*) AS n FROM project_repos").first<{ n: number }>();
    expect(projects?.n).toBe(0);
    expect(repos?.n).toBe(0);
  });
});
