import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
export { getCookie, setCookie };
import type { AppEnv } from "./env";
import { AppError } from "./error";

export const SESSION_COOKIE = "spectrace_session";
export const STATE_COOKIE = "spectrace_oauth_state";
export const SESSION_DAYS = 30;
export const STATE_MAX_AGE_SECS = 600;

/** The signed-in user, as returned by `/api/me`. */
export interface User {
  id: string;
  github_id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
}

export interface GithubConfig {
  clientId: string;
  clientSecret: string;
  publicUrl: string;
  oauthUrl: string;
  apiUrl: string;
  secureCookies: boolean;
}

export function githubConfig(c: Context<AppEnv>): GithubConfig {
  const { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, PUBLIC_URL, GITHUB_OAUTH_URL, GITHUB_API_URL } = c.env;
  if (!GITHUB_CLIENT_ID?.trim() || !GITHUB_CLIENT_SECRET?.trim()) {
    throw new AppError("not_configured", "GitHub sign-in is not configured on this server");
  }
  const publicUrl = (PUBLIC_URL?.trim() || new URL(c.req.url).origin).replace(/\/+$/, "");
  return {
    clientId: GITHUB_CLIENT_ID,
    clientSecret: GITHUB_CLIENT_SECRET,
    publicUrl,
    oauthUrl: (GITHUB_OAUTH_URL ?? "https://github.com").replace(/\/+$/, ""),
    apiUrl: (GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, ""),
    secureCookies: publicUrl.startsWith("https://"),
  };
}

export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function cookieOptions(secure: boolean, maxAge: number) {
  return { path: "/", httpOnly: true, sameSite: "Lax" as const, maxAge, secure };
}

/** The user behind the session cookie; throws 401 when there is none or it expired. */
export async function requireUser(c: Context<AppEnv>): Promise<User> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) throw AppError.unauthorized("not signed in");
  const user = await c.env.DB.prepare(
    `SELECT u.id, u.github_id, u.login, u.name, u.avatar_url
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?1 AND s.expires_at > ?2`,
  )
    .bind(await hashToken(token), new Date().toISOString())
    .first<User>();
  if (!user) throw AppError.unauthorized("session expired or unknown");
  return user;
}

export function clearCookie(c: Context<AppEnv>, name: string, secure: boolean) {
  deleteCookie(c, name, { path: "/", secure });
}

