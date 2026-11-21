import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetInstallationTokens } from "../src/github-app";
import { TEST_APP_PUBLIC_KEY } from "./app-key";

const BASE = "http://spectrace.test";
const call = (path: string, init: RequestInit = {}) => exports.default.fetch(new Request(`${BASE}${path}`, { redirect: "manual", ...init }));

const repo = (owner: string, name: string, id: number) => ({
  id,
  name,
  full_name: `${owner}/${name}`,
  private: id % 2 === 0,
  default_branch: "main",
  html_url: `https://github.example/${owner}/${name}`,
  owner: { login: owner },
});
const inst = (id: number, login: string, type: string, sel: string) => ({ id, repository_selection: sel, account: { id: id + 7, login, type } });

let mints = 0;

async function jwtIsValid(jwt: string): Promise<boolean> {
  const [head, claims, sig] = jwt.split(".");
  if (!head || !claims || !sig) return false;
  const b64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const der = b64(TEST_APP_PUBLIC_KEY.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "").replace(/\+/g, "-").replace(/\//g, "_"));
  const key = await crypto.subtle.importKey("spki", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64(sig), new TextEncoder().encode(`${head}.${claims}`));
  const c = JSON.parse(new TextDecoder().decode(b64(claims))) as { iss: string; exp: number };
  return ok && c.iss === "12345" && c.exp * 1000 > Date.now();
}

/**
 * A fake GitHub. Two people: octocat (id 8073584, token gho_octocat) and mona
 * (id 42, gho_mona). Installation 1001 is octocat's own, 2002 is the acme org
 * (150 repos, so the list needs two pages), 3003 is mona's, 9999 is gone.
 */
function mockGithub() {
  const real = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    const bearer = (req.headers.get("authorization") ?? "").replace("Bearer ", "");
    if (url.origin === "http://github.test" && url.pathname === "/login/oauth/access_token") {
      const code = (await req.formData()).get("code");
      if (code === "good-code" || code === "install-code") return Response.json({ access_token: "gho_octocat" });
      if (code === "mona-code") return Response.json({ access_token: "gho_mona" });
      return Response.json({ error: "bad_verification_code" });
    }
    if (url.origin !== "http://api.github.test") return real(input, init);
    const path = url.pathname;
    if (path === "/user") {
      if (bearer === "gho_octocat") return Response.json({ id: 8073584, login: "octocat" });
      if (bearer === "gho_mona") return Response.json({ id: 42, login: "mona" });
      return Response.json({}, { status: 401 });
    }
    if (path === "/user/installations") {
      const list = bearer === "gho_octocat" ? [inst(1001, "octocat", "User", "all"), inst(2002, "acme", "Organization", "selected")] : bearer === "gho_mona" ? [inst(3003, "mona", "User", "all")] : [];
      return Response.json({ total_count: list.length, installations: list });
    }
    const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (mint) {
      if (!(await jwtIsValid(bearer))) return Response.json({}, { status: 401 });
      const id = Number(mint[1]);
      if (id === 9999) return Response.json({}, { status: 404 });
      mints++;
      return Response.json({ token: `ghs_${id}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 });
    }
    if (path === "/installation/repositories") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const all =
        bearer === "ghs_1001" ? [repo("octocat", "hello", 1), repo("octocat", "spoon", 2)]
        : bearer === "ghs_2002" ? Array.from({ length: 150 }, (_, i) => repo("acme", `r${String(i).padStart(3, "0")}`, 100 + i))
        : bearer === "ghs_3003" ? [repo("mona", "secret", 3)]
        : null;
      if (!all) return Response.json({}, { status: 401 });
      return Response.json({ total_count: all.length, repositories: all.slice((page - 1) * 100, page * 100) });
    }
    return Response.json({}, { status: 404 });
  });
}

const pair = (res: Response, name: string): string | null => {
  const raw = res.headers.getSetCookie().find((v) => v.startsWith(`${name}=`));
  return raw ? raw.split(";")[0]! : null;
};

async function signIn(): Promise<string> {
  const login = await call("/api/auth/github/login");
  const stateCookie = pair(login, "spectrace_oauth_state")!;
  const state = stateCookie.split("=")[1]!;
  const cb = await call(`/api/auth/github/callback?code=good-code&state=${state}`, { headers: { cookie: stateCookie } });
  return pair(cb, "spectrace_session")!;
}

async function startInstall(session: string) {
  const res = await call("/api/github/install", { headers: { cookie: session } });
  expect(res.status).toBe(303);
  return { location: res.headers.get("location")!, stateCookie: pair(res, "spectrace_install_state")! };
}

async function install(session: string, installationId: number, code: string, extra = "") {
  const { stateCookie } = await startInstall(session);
  const state = stateCookie.split("=")[1]!;
  return call(`/api/github/install/callback?installation_id=${installationId}&setup_action=install&code=${code}&state=${state}${extra}`, {
    headers: { cookie: `${session}; ${stateCookie}` },
  });
}

async function repos(session: string) {
  const res = await call("/api/github/repos", { headers: { cookie: session } });
  expect(res.status).toBe(200);
  return (await res.json()) as { full_name: string; name: string; owner: string; installation_id: number; default_branch: string; private: boolean }[];
}

beforeEach(async () => {
  mints = 0;
  forgetInstallationTokens();
  mockGithub();
  await env.DB.exec("DELETE FROM user_installations; DELETE FROM github_installations; DELETE FROM sessions; DELETE FROM users;");
});
afterEach(() => vi.restoreAllMocks());

describe("GitHub App", () => {
  it("the repo list only has repos from the user's installations", async () => {
    const session = await signIn();
    expect(await repos(session)).toEqual([]);

    const { location, stateCookie } = await startInstall(session);
    expect(location).toContain("http://github.test/apps/spectrace-test/installations/new");
    expect(location).toContain(`state=${stateCookie.split("=")[1]}`);

    for (const id of [1001, 2002]) {
      const res = await install(session, id, "install-code");
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/?github_app=installed");
    }
    // Installing twice is fine.
    expect((await install(session, 1001, "install-code")).status).toBe(303);

    // Someone else's installation, already in the database.
    const mona = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, github_id, login) VALUES (?1, 42, 'mona')").bind(mona),
      env.DB.prepare("INSERT INTO github_installations (id, account_id, account_login, account_type, repository_selection) VALUES (3003, 3010, 'mona', 'User', 'all')"),
      env.DB.prepare("INSERT INTO user_installations (user_id, installation_id) VALUES (?1, 3003)").bind(mona),
    ]);

    const list = await repos(session);
    const names = list.map((r) => r.full_name);
    expect(names).toHaveLength(152); // 2 personal + 150 org, two pages
    expect(names.every((n) => n.startsWith("octocat/") || n.startsWith("acme/"))).toBe(true);
    expect(names).not.toContain("mona/secret");
    expect(names).toEqual([...names].sort());
    expect(list.find((r) => r.name === "hello")).toMatchObject({ owner: "octocat", installation_id: 1001, default_branch: "main", private: false });

    const stored = await env.DB.prepare("SELECT account_login, account_type FROM github_installations WHERE id = 2002").first();
    expect(stored).toEqual({ account_login: "acme", account_type: "Organization" });

    // Tokens are reused until they near expiry: a second list mints nothing new.
    expect(mints).toBe(2);
    await repos(session);
    expect(mints).toBe(2);
  });

  it("install callback refuses what GitHub does not vouch for", async () => {
    const session = await signIn();
    expect((await install(session, 3003, "install-code")).status).toBe(400); // not octocat's installation
    expect((await install(session, 3003, "mona-code")).status).toBe(400); // authorization from someone else
    expect((await install(session, 1001, "nope")).status).toBe(400); // code GitHub rejects

    const { stateCookie } = await startInstall(session);
    const state = stateCookie.split("=")[1]!;
    const noCode = await call(`/api/github/install/callback?installation_id=1001&state=${state}`, { headers: { cookie: `${session}; ${stateCookie}` } });
    expect(noCode.status).toBe(400);
    const wrongState = await call("/api/github/install/callback?installation_id=1001&code=install-code&state=x", { headers: { cookie: `${session}; ${stateCookie}` } });
    expect(wrongState.status).toBe(400);

    const n = await env.DB.prepare("SELECT count(*) AS n FROM github_installations").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("a request for org-owner approval records nothing", async () => {
    const session = await signIn();
    const { stateCookie } = await startInstall(session);
    const state = stateCookie.split("=")[1]!;
    const res = await call(`/api/github/install/callback?setup_action=request&state=${state}`, { headers: { cookie: `${session}; ${stateCookie}` } });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/?github_app=requested");
    const n = await env.DB.prepare("SELECT count(*) AS n FROM github_installations").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("an uninstalled installation is forgotten", async () => {
    const session = await signIn();
    await install(session, 1001, "install-code");
    const user = await env.DB.prepare("SELECT id FROM users WHERE github_id = 8073584").first<{ id: string }>();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO github_installations (id, account_id, account_login, account_type, repository_selection) VALUES (9999, 1, 'gone', 'User', 'all')"),
      env.DB.prepare("INSERT INTO user_installations (user_id, installation_id) VALUES (?1, 9999)").bind(user!.id),
    ]);
    expect(await repos(session)).toHaveLength(2);
    const left = await env.DB.prepare("SELECT id FROM github_installations").all<{ id: number }>();
    expect(left.results.map((r) => r.id)).toEqual([1001]);
  });

  it("answers 502 when GitHub fails while listing", async () => {
    const session = await signIn();
    await install(session, 1001, "install-code");
    vi.restoreAllMocks();
    forgetInstallationTokens();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({}, { status: 500 }));
    const res = await call("/api/github/repos", { headers: { cookie: session } });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { code: "upstream", message: "internal server error" } });
  });

  it("needs sign-in, and app settings", async () => {
    for (const path of ["/api/github/repos", "/api/github/install", "/api/github/install/callback"]) {
      expect((await call(path)).status, path).toBe(401);
    }
    const session = await signIn();
    const saved = env.GITHUB_APP_PRIVATE_KEY;
    env.GITHUB_APP_PRIVATE_KEY = "";
    try {
      const res = await call("/api/github/repos", { headers: { cookie: session } });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: { code: "internal", message: "internal server error" } });
    } finally {
      env.GITHUB_APP_PRIVATE_KEY = saved;
    }
  });

  it("is in the OpenAPI document", async () => {
    const doc = (await (await call("/api/openapi.json")).json()) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(["/api/github/install", "/api/github/install/callback", "/api/github/repos"]));
  });
});
