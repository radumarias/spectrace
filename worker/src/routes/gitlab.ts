// Connecting a GitLab account (the server's GITLAB_URL instance) and listing
// its repositories for the repo picker.
import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { clearCookie, cookieOptions, getCookie, randomToken, requireUser, setCookie, STATE_MAX_AGE_SECS } from "../auth";
import type { AppEnv } from "../env";
import { AppError, ErrorBody } from "../error";
import { connectionOf, gitlabConfig, gitlabConfigOrNull, gitlabToken, gitlabUserRepos, gitlabWhoAmI, oauthToken, saveConnection, saveOauthTokens } from "../gitlab";

const STATE_COOKIE = "spectrace_gitlab_state";

const Status = z
  .object({
    configured: z.boolean().openapi({ description: "This server has a GitLab instance (GITLAB_URL)" }),
    url: z.string().nullable().openapi({ example: "https://gitlab.example.com" }),
    oauth: z.boolean().openapi({ description: "Connecting through the instance's OAuth application is possible; otherwise only with a token" }),
    account: z.object({ username: z.string(), kind: z.enum(["oauth", "token"]) }).nullable(),
  })
  .openapi("GitlabStatus");

const Repo = z
  .object({ id: z.number().int(), full_name: z.string(), name: z.string(), default_branch: z.string(), private: z.boolean(), html_url: z.string() })
  .openapi("GitlabRepo");

const TokenBody = z.object({ token: z.string().min(1).max(500).openapi({ description: "A personal access token with the api scope" }) }).openapi("GitlabToken");

const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorBody } } });

const statusRoute = createRoute({
  method: "get",
  path: "/api/gitlab",
  summary: "Whether GitLab is on, and the signed-in user's GitLab account",
  responses: { 200: { description: "Status", content: { "application/json": { schema: Status } } }, 401: err("Not signed in") },
});

const connectRoute = createRoute({
  method: "get",
  path: "/api/gitlab/connect",
  summary: "Start connecting a GitLab account (redirects to GitLab)",
  responses: { 303: { description: "Redirect to GitLab" }, 401: err("Not signed in"), 503: err("GitLab or its OAuth application is not configured") },
});

const callbackRoute = createRoute({
  method: "get",
  path: "/api/gitlab/callback",
  summary: "GitLab redirects back here; stores the account",
  request: { query: z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }) },
  responses: { 303: { description: "Connected, redirect to /project?gitlab=connected" }, 400: err("Bad request"), 401: err("Not signed in"), 502: err("GitLab failed") },
});

const tokenRoute = createRoute({
  method: "post",
  path: "/api/gitlab/token",
  summary: "Connect a GitLab account with a personal access token",
  request: { body: { content: { "application/json": { schema: TokenBody } }, required: true } },
  responses: {
    200: { description: "Connected", content: { "application/json": { schema: Status } } },
    400: err("GitLab did not accept the token"),
    401: err("Not signed in"),
    503: err("GitLab is not configured"),
  },
});

const disconnectRoute = createRoute({
  method: "delete",
  path: "/api/gitlab",
  summary: "Forget the signed-in user's GitLab account",
  responses: { 204: { description: "Forgotten (also when there was none)" }, 401: err("Not signed in") },
});

const reposRoute = createRoute({
  method: "get",
  path: "/api/gitlab/repos",
  summary: "GitLab repositories the signed-in user can push to",
  responses: {
    200: { description: "Repositories, sorted by path; empty when no account is connected", content: { "application/json": { schema: z.array(Repo) } } },
    401: err("Not signed in"),
    502: err("GitLab failed"),
  },
});

function publicUrl(c: Context<AppEnv>): string {
  return (c.env.PUBLIC_URL?.trim() || new URL(c.req.url).origin).replace(/\/+$/, "");
}

async function status(c: Context<AppEnv>, userId: string): Promise<z.infer<typeof Status>> {
  const cfg = gitlabConfigOrNull(c.env);
  const row = cfg ? await connectionOf(c.env, userId) : null;
  return { configured: cfg !== null, url: cfg?.url ?? null, oauth: cfg?.oauth !== null && cfg !== null, account: row ? { username: row.username, kind: row.kind } : null };
}

export function registerGitlab(app: OpenAPIHono<AppEnv>) {
  app.openapi(statusRoute, async (c) => {
    const user = await requireUser(c);
    return c.json(await status(c, user.id), 200);
  });

  app.openapi(connectRoute, async (c) => {
    await requireUser(c);
    const cfg = gitlabConfig(c.env);
    if (!cfg.oauth) throw new AppError("not_configured", "GitLab sign-in is not configured on this server (GITLAB_CLIENT_ID, GITLAB_CLIENT_SECRET)");
    const base = publicUrl(c);
    const state = randomToken();
    const url = new URL(`${cfg.url}/oauth/authorize`);
    url.searchParams.set("client_id", cfg.oauth.clientId);
    url.searchParams.set("redirect_uri", `${base}/api/gitlab/callback`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "api read_user");
    url.searchParams.set("state", state);
    setCookie(c, STATE_COOKIE, state, cookieOptions(base.startsWith("https://"), STATE_MAX_AGE_SECS));
    return c.redirect(url.toString(), 303);
  });

  app.openapi(callbackRoute, async (c) => {
    const user = await requireUser(c);
    const cfg = gitlabConfig(c.env);
    const base = publicUrl(c);
    const { code, state, error } = c.req.valid("query");
    if (error) throw AppError.badRequest(`GitLab refused: ${error}`);
    if (!code || !state) throw AppError.badRequest("missing code or state");
    const expected = getCookie(c, STATE_COOKIE);
    if (!expected || expected !== state) throw AppError.badRequest("connect state does not match");
    clearCookie(c, STATE_COOKIE, base.startsWith("https://"));
    const t = await oauthToken(cfg, { grant_type: "authorization_code", code, redirect_uri: `${base}/api/gitlab/callback` });
    if (!t.access_token) throw AppError.badRequest(`GitLab did not accept the code: ${t.error_description ?? t.error ?? ""}`);
    const who = await gitlabWhoAmI(cfg, t.access_token);
    if (!who) throw new AppError("upstream", "GitLab did not accept its own token");
    await saveOauthTokens(c.env, user.id, who, t);
    return c.redirect("/project?gitlab=connected", 303);
  });

  app.openapi(tokenRoute, async (c) => {
    const user = await requireUser(c);
    const cfg = gitlabConfig(c.env);
    const token = c.req.valid("json").token.trim();
    const who = await gitlabWhoAmI(cfg, token);
    if (!who) throw AppError.badRequest("GitLab did not accept that token.");
    await saveConnection(c.env, user.id, who, "token", { access: token, refresh: null, expiresAt: null });
    return c.json(await status(c, user.id), 200);
  });

  app.openapi(disconnectRoute, async (c) => {
    const user = await requireUser(c);
    await c.env.DB.prepare("DELETE FROM gitlab_connections WHERE user_id = ?1").bind(user.id).run();
    return c.body(null, 204);
  });

  app.openapi(reposRoute, async (c) => {
    const user = await requireUser(c);
    const cfg = gitlabConfigOrNull(c.env);
    if (!cfg) return c.json([], 200);
    const token = await gitlabToken(c.env, cfg, user.id);
    if (!token) return c.json([], 200);
    return c.json(await gitlabUserRepos(cfg, token), 200);
  });
}
