import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BASE = "http://spectrace.test";
const call = (path: string, init: RequestInit = {}) => exports.default.fetch(new Request(`${BASE}${path}`, { redirect: "manual", ...init }));

/** A fake GitHub: accepts code `good-code`, knows one user. */
function mockGithub() {
  const real = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    if (url.origin === "http://github.test" && url.pathname === "/login/oauth/access_token") {
      const form = await req.formData();
      if (form.get("code") === "good-code" && form.get("client_secret") === "shh") {
        return Response.json({ access_token: "gho_fake", token_type: "bearer" });
      }
      return Response.json({ error: "bad_verification_code", error_description: "nope" });
    }
    if (url.origin === "http://api.github.test" && url.pathname === "/user") {
      if (req.headers.get("authorization") !== "Bearer gho_fake") return Response.json({}, { status: 401 });
      return Response.json({ id: 8073584, login: "octocat", name: "The Octocat", avatar_url: "https://avatars.example/octocat.png" });
    }
    return real(input, init);
  });
}

/** `name=value` of a Set-Cookie header, or null. */
function setCookiePair(res: Response, name: string): string | null {
  const raw = res.headers.getSetCookie().find((v) => v.startsWith(`${name}=`));
  return raw ? raw.split(";")[0]! : null;
}

/** Runs login + callback; returns the session cookie pair. */
async function signIn(): Promise<string> {
  const login = await call("/api/auth/github/login");
  expect(login.status).toBe(303);
  const location = login.headers.get("location")!;
  expect(location).toContain("http://github.test/login/oauth/authorize?client_id=cid");
  const stateCookie = setCookiePair(login, "spectrace_oauth_state")!;
  const state = stateCookie.split("=")[1]!;
  expect(location).toContain(`state=${state}`);

  const cb = await call(`/api/auth/github/callback?code=good-code&state=${state}`, { headers: { cookie: stateCookie } });
  expect(cb.status).toBe(303);
  expect(cb.headers.get("location")).toBe("/");
  const raw = cb.headers.getSetCookie().find((v) => v.startsWith("spectrace_session="))!;
  expect(raw).toContain("HttpOnly");
  expect(raw).toContain("SameSite=Lax");
  return raw.split(";")[0]!;
}

beforeEach(async () => {
  mockGithub();
  await env.DB.exec("DELETE FROM sessions; DELETE FROM users;");
});
afterEach(() => vi.restoreAllMocks());

describe("sign in with GitHub", () => {
  it("signs in, reads /api/me, and sign out clears the session", async () => {
    const signedOut = await call("/api/me");
    expect(signedOut.status).toBe(401);
    expect(((await signedOut.json()) as { error: { code: string } }).error.code).toBe("unauthorized");

    const session = await signIn();

    const res = await call("/api/me", { headers: { cookie: session } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ login: "octocat", github_id: 8073584, name: "The Octocat", avatar_url: "https://avatars.example/octocat.png" });

    // The raw cookie token is never stored; only its hash is.
    const token = session.split("=")[1]!;
    const stored = await env.DB.prepare("SELECT count(*) AS n FROM sessions WHERE token_hash = ?1").bind(token).first<{ n: number }>();
    expect(stored?.n).toBe(0);

    // Signing in again reuses the same user row.
    await signIn();
    const users = await env.DB.prepare("SELECT count(*) AS n FROM users").first<{ n: number }>();
    expect(users?.n).toBe(1);

    const out = await call("/api/auth/logout", { method: "POST", headers: { cookie: session } });
    expect(out.status).toBe(204);
    expect(out.headers.getSetCookie().find((v) => v.startsWith("spectrace_session="))).toMatch(/Max-Age=0/);
    expect((await call("/api/me", { headers: { cookie: session } })).status).toBe(401);
  });

  it("rejects an expired session", async () => {
    const session = await signIn();
    await env.DB.exec("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'");
    expect((await call("/api/me", { headers: { cookie: session } })).status).toBe(401);
  });

  it("callback rejects a wrong state and a code GitHub refuses", async () => {
    const wrong = await call("/api/auth/github/callback?code=good-code&state=abc", { headers: { cookie: "spectrace_oauth_state=other" } });
    expect(wrong.status).toBe(400);
    const missing = await call("/api/auth/github/callback?code=good-code&state=abc");
    expect(missing.status).toBe(400);
    const bad = await call("/api/auth/github/callback?code=bad&state=abc", { headers: { cookie: "spectrace_oauth_state=abc" } });
    expect(bad.status).toBe(400);
    expect(setCookiePair(bad, "spectrace_session")).toBeNull();
    const refused = await call("/api/auth/github/callback?error=access_denied");
    expect(refused.status).toBe(400);
  });

  it("answers 502 when GitHub's profile request fails", async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(new Request(input as RequestInfo).url);
      return url.pathname === "/login/oauth/access_token" ? Response.json({ access_token: "other" }) : Response.json({}, { status: 500 });
    });
    const res = await call("/api/auth/github/callback?code=x&state=s", { headers: { cookie: "spectrace_oauth_state=s" } });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { code: "upstream", message: "internal server error" } });
  });

  it("login without OAuth settings says sign-in is not configured", async () => {
    const saved = env.GITHUB_CLIENT_ID;
    env.GITHUB_CLIENT_ID = "";
    try {
      const res = await call("/api/auth/github/login");
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: { code: "not_configured", message: "GitHub sign-in is not configured on this server" } });
    } finally {
      env.GITHUB_CLIENT_ID = saved;
    }
  });

  it("logout without a session is fine", async () => {
    expect((await call("/api/auth/logout", { method: "POST" })).status).toBe(204);
  });

  it("is in the OpenAPI document", async () => {
    const doc = (await (await call("/api/openapi.json")).json()) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(["/api/me", "/api/auth/logout", "/api/auth/github/login", "/api/auth/github/callback"]));
  });
});
