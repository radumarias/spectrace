import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../env";
import { AppError, ErrorBody } from "../error";
import { linkUserInstallations } from "../github-app";
import {
  SESSION_COOKIE,
  SESSION_DAYS,
  STATE_COOKIE,
  STATE_MAX_AGE_SECS,
  clearCookie,
  cookieOptions,
  getCookie,
  githubConfig,
  hashToken,
  randomToken,
  requireUser,
  setCookie,
} from "../auth";

const UserSchema = z
  .object({
    id: z.string(),
    github_id: z.number().int(),
    login: z.string(),
    name: z.string().nullable(),
    avatar_url: z.string().nullable(),
  })
  .openapi("User");

const errors = {
  400: { description: "Bad request", content: { "application/json": { schema: ErrorBody } } },
  500: { description: "Server error", content: { "application/json": { schema: ErrorBody } } },
};

const loginRoute = createRoute({
  method: "get",
  path: "/api/auth/github/login",
  summary: "Start GitHub sign-in (redirects to GitHub)",
  responses: { 303: { description: "Redirect to GitHub" }, 503: { description: "GitHub sign-in is not configured", content: { "application/json": { schema: ErrorBody } } }, 500: errors[500] },
});

const callbackRoute = createRoute({
  method: "get",
  path: "/api/auth/github/callback",
  summary: "GitHub redirects back here; starts a session",
  request: {
    query: z.object({
      code: z.string().optional(),
      state: z.string().optional(),
      error: z.string().optional(),
      setup_action: z.string().optional(),
    }),
  },
  responses: { 303: { description: "Signed in, redirect to /" }, ...errors, 502: { description: "GitHub failed", content: { "application/json": { schema: ErrorBody } } } },
});

const meRoute = createRoute({
  method: "get",
  path: "/api/me",
  summary: "The signed-in user",
  responses: {
    200: { description: "The user", content: { "application/json": { schema: UserSchema } } },
    401: { description: "Not signed in", content: { "application/json": { schema: ErrorBody } } },
  },
});

const logoutRoute = createRoute({
  method: "post",
  path: "/api/auth/logout",
  summary: "Sign out",
  responses: { 204: { description: "Session ended (also when there was none)" } },
});

interface GithubProfile {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
}

async function upstreamJson<T>(what: string, req: Promise<Response>): Promise<{ res: Response; body: T }> {
  try {
    const res = await req;
    return { res, body: (await res.json()) as T };
  } catch (cause) {
    throw new AppError("upstream", `GitHub ${what}: ${String(cause)}`, { cause });
  }
}

export function registerAuth(app: OpenAPIHono<AppEnv>) {
  app.openapi(loginRoute, (c) => {
    const gh = githubConfig(c);
    const state = randomToken();
    const url = new URL(`${gh.oauthUrl}/login/oauth/authorize`);
    url.searchParams.set("client_id", gh.clientId);
    url.searchParams.set("redirect_uri", `${gh.publicUrl}/api/auth/github/callback`);
    url.searchParams.set("scope", "read:user");
    url.searchParams.set("state", state);
    setCookie(c, STATE_COOKIE, state, cookieOptions(gh.secureCookies, STATE_MAX_AGE_SECS));
    return c.redirect(url.toString(), 303);
  });

  app.openapi(callbackRoute, async (c) => {
    const gh = githubConfig(c);
    const { code, state, error, setup_action } = c.req.valid("query");
    if (error) throw AppError.badRequest(`GitHub refused sign-in: ${error}`);
    if (!code || !state) throw AppError.badRequest("missing code or state");
    const expected = getCookie(c, STATE_COOKIE);
    if (!expected || expected !== state) {
      // The App's setup URL can point here: GitHub sends people back after installing, with no sign-in state.
      // Start a normal sign-in; it links the new installation.
      if (setup_action) return c.redirect("/api/auth/github/login", 303);
      throw AppError.badRequest("sign-in state does not match");
    }

    const token = await upstreamJson<{ access_token?: string; error_description?: string }>(
      "token request",
      fetch(`${gh.oauthUrl}/login/oauth/access_token`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: gh.clientId,
          client_secret: gh.clientSecret,
          code,
          redirect_uri: `${gh.publicUrl}/api/auth/github/callback`,
        }),
      }),
    );
    const accessToken = token.body.access_token;
    if (!accessToken) throw AppError.badRequest(`GitHub did not accept the code: ${token.body.error_description ?? ""}`);

    const profile = await upstreamJson<GithubProfile>(
      "user request",
      fetch(`${gh.apiUrl}/user`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "spectrace", authorization: `Bearer ${accessToken}` },
      }),
    );
    if (!profile.res.ok) throw new AppError("upstream", `GitHub user request: status ${profile.res.status}`);
    const p = profile.body;

    const now = new Date();
    const user = await c.env.DB.prepare(
      `INSERT INTO users (id, github_id, login, name, avatar_url, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
       ON CONFLICT (github_id) DO UPDATE
         SET login = excluded.login, name = excluded.name,
             avatar_url = excluded.avatar_url, updated_at = excluded.updated_at
       RETURNING id`,
    )
      .bind(crypto.randomUUID(), p.id, p.login, p.name ?? null, p.avatar_url ?? null, now.toISOString())
      .first<{ id: string }>();
    if (!user) throw new AppError("internal", "user upsert returned no row");

    // An App installed before (or without coming back through the install page) is picked up on every sign-in.
    await linkUserInstallations(c.env.DB, gh.apiUrl, user.id, accessToken);

    const sessionToken = randomToken();
    const expires = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
    await c.env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(crypto.randomUUID(), user.id, await hashToken(sessionToken), now.toISOString(), expires.toISOString())
      .run();

    setCookie(c, SESSION_COOKIE, sessionToken, cookieOptions(gh.secureCookies, SESSION_DAYS * 86_400));
    clearCookie(c, STATE_COOKIE, gh.secureCookies);
    return c.redirect("/", 303);
  });

  app.openapi(meRoute, async (c) => c.json(await requireUser(c), 200));

  app.openapi(logoutRoute, async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?1").bind(await hashToken(token)).run();
    const secure = (c.env.PUBLIC_URL ?? new URL(c.req.url).origin).startsWith("https://");
    clearCookie(c, SESSION_COOKIE, secure);
    return c.body(null, 204);
  });
}
