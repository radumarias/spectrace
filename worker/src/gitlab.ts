// GitLab accounts: one per spectrace user, on the server's GitLab instance
// (`GITLAB_URL`, self-hosted or gitlab.com). Connected through the instance's
// OAuth application (tokens live two hours and are refreshed here), or with a
// personal access token. Either way the token is sealed in D1 and only opened
// in memory to call GitLab.
import type { Bindings } from "./env";
import { AppError } from "./error";
import { seal, unseal } from "./user-keys";

export interface GitlabConfig {
  /** The instance, no trailing slash: `https://gitlab.example.com`. */
  url: string;
  /** `<url>/api/v4`. */
  apiUrl: string;
  /** Set when the OAuth application is configured; personal access tokens work without it. */
  oauth: { clientId: string; clientSecret: string } | null;
}

/** The instance, or null when this server has no GitLab. */
export function gitlabConfigOrNull(env: Bindings): GitlabConfig | null {
  const raw = env.GITLAB_URL?.trim();
  if (!raw) return null;
  const url = raw.replace(/\/+$/, "");
  const id = env.GITLAB_CLIENT_ID?.trim();
  const secret = env.GITLAB_CLIENT_SECRET?.trim();
  return { url, apiUrl: `${url}/api/v4`, oauth: id && secret ? { clientId: id, clientSecret: secret } : null };
}

export function gitlabConfig(env: Bindings): GitlabConfig {
  const cfg = gitlabConfigOrNull(env);
  if (!cfg) throw new AppError("not_configured", "GitLab is not configured on this server (GITLAB_URL)");
  return cfg;
}

export const glHeaders = (token: string): HeadersInit => ({ accept: "application/json", "user-agent": "spectrace", authorization: `Bearer ${token}` });

/** A GitLab user as `GET /user` answers. */
export interface GitlabUser {
  id: number;
  username: string;
  name?: string;
}

/** Who a token belongs to, or null when GitLab does not accept it. */
export async function gitlabWhoAmI(cfg: GitlabConfig, token: string): Promise<GitlabUser | null> {
  let res: Response;
  try {
    res = await fetch(`${cfg.apiUrl}/user`, { headers: glHeaders(token) });
  } catch (cause) {
    throw new AppError("upstream", `GitLab user request: ${String(cause)}`, { cause });
  }
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new AppError("upstream", `GitLab user request: status ${res.status}`);
  return (await res.json()) as GitlabUser;
}

interface TokenAnswer {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  created_at?: number;
  error?: string;
  error_description?: string;
}

/** Exchange an authorization code or a refresh token at `/oauth/token`. */
export async function oauthToken(cfg: GitlabConfig, params: Record<string, string>): Promise<TokenAnswer> {
  if (!cfg.oauth) throw new AppError("not_configured", "GitLab sign-in is not configured on this server (GITLAB_CLIENT_ID, GITLAB_CLIENT_SECRET)");
  let res: Response;
  try {
    res = await fetch(`${cfg.url}/oauth/token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: cfg.oauth.clientId, client_secret: cfg.oauth.clientSecret, ...params }),
    });
  } catch (cause) {
    throw new AppError("upstream", `GitLab token request: ${String(cause)}`, { cause });
  }
  if (res.status >= 500) throw new AppError("upstream", `GitLab token request: status ${res.status}`);
  return (await res.json().catch(() => ({}))) as TokenAnswer;
}

const expiry = (t: TokenAnswer, now = Date.now()) => (t.expires_in ? new Date(now + t.expires_in * 1000).toISOString() : null);

export interface Connection {
  user_id: string;
  gitlab_user_id: number;
  username: string;
  kind: "oauth" | "token";
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  updated_at: string;
}

/** Store (or replace) a user's GitLab account. */
export async function saveConnection(
  env: Bindings,
  userId: string,
  who: GitlabUser,
  kind: "oauth" | "token",
  token: { access: string; refresh: string | null; expiresAt: string | null },
): Promise<void> {
  const access = await seal(env, userId, token.access);
  const refresh = token.refresh ? await seal(env, userId, token.refresh) : null;
  await env.DB.prepare(
    `INSERT INTO gitlab_connections (user_id, gitlab_user_id, username, kind, access_token, refresh_token, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (user_id) DO UPDATE SET gitlab_user_id = excluded.gitlab_user_id, username = excluded.username, kind = excluded.kind,
       access_token = excluded.access_token, refresh_token = excluded.refresh_token, expires_at = excluded.expires_at,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  )
    .bind(userId, who.id, who.username, kind, access, refresh, token.expiresAt)
    .run();
}

export async function saveOauthTokens(env: Bindings, userId: string, who: GitlabUser, t: TokenAnswer): Promise<void> {
  if (!t.access_token) throw new AppError("upstream", "GitLab sent no access token");
  await saveConnection(env, userId, who, "oauth", { access: t.access_token, refresh: t.refresh_token ?? null, expiresAt: expiry(t) });
}

export function connectionOf(env: Bindings, userId: string): Promise<Connection | null> {
  return env.DB.prepare("SELECT * FROM gitlab_connections WHERE user_id = ?1").bind(userId).first<Connection>();
}

/** Refresh this long before GitLab's own expiry. */
const REFRESH_SLACK_MS = 5 * 60_000;

/**
 * A working access token for a user, refreshing an OAuth token that is about
 * to expire; null when the user has no GitLab account connected, or GitLab
 * no longer accepts the refresh token (they connect again).
 */
export async function gitlabToken(env: Bindings, cfg: GitlabConfig, userId: string): Promise<string | null> {
  const row = await connectionOf(env, userId);
  if (!row) return null;
  const access = await unseal(env, userId, row.access_token);
  if (row.kind === "token" || !row.expires_at || Date.parse(row.expires_at) - REFRESH_SLACK_MS > Date.now() || !row.refresh_token) return access;
  const t = await oauthToken(cfg, { grant_type: "refresh_token", refresh_token: await unseal(env, userId, row.refresh_token) });
  if (!t.access_token) {
    // GitLab rotates refresh tokens: another request may have just used this one. Take what it stored.
    const again = await connectionOf(env, userId);
    if (again && again.updated_at !== row.updated_at) return unseal(env, userId, again.access_token);
    return null;
  }
  await env.DB.prepare(
    `UPDATE gitlab_connections SET access_token = ?2, refresh_token = ?3, expires_at = ?4, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ?1`,
  )
    .bind(userId, await seal(env, userId, t.access_token), t.refresh_token ? await seal(env, userId, t.refresh_token) : row.refresh_token, expiry(t))
    .run();
  return t.access_token;
}

/** A project (repository) the user can push to, as the repo picker shows it. */
export interface GitlabRepo {
  id: number;
  full_name: string;
  name: string;
  default_branch: string;
  private: boolean;
  html_url: string;
}

const MAX_REPO_PAGES = 10;

/** Projects the user is a Developer or more on, sorted by path. */
export async function gitlabUserRepos(cfg: GitlabConfig, token: string): Promise<GitlabRepo[]> {
  const out: GitlabRepo[] = [];
  for (let page = 1; page <= MAX_REPO_PAGES; page++) {
    let res: Response;
    try {
      res = await fetch(`${cfg.apiUrl}/projects?membership=true&min_access_level=30&simple=true&archived=false&order_by=path&sort=asc&per_page=100&page=${page}`, {
        headers: glHeaders(token),
      });
    } catch (cause) {
      throw new AppError("upstream", `GitLab projects request: ${String(cause)}`, { cause });
    }
    if (!res.ok) throw new AppError("upstream", `GitLab projects request: status ${res.status}`);
    const batch = (await res.json()) as { id: number; path_with_namespace: string; name: string; default_branch?: string | null; visibility?: string; web_url: string }[];
    for (const p of batch) {
      out.push({ id: p.id, full_name: p.path_with_namespace, name: p.name, default_branch: p.default_branch ?? "main", private: p.visibility !== "public", html_url: p.web_url });
    }
    if (batch.length < 100) break;
  }
  out.sort((a, b) => (a.full_name.toLowerCase() < b.full_name.toLowerCase() ? -1 : 1));
  return out;
}
