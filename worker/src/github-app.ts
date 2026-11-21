import type { Context } from "hono";
import type { AppEnv, Bindings } from "./env";
import { AppError } from "./error";
import { githubConfig } from "./auth";

export interface AppConfig {
  appId: string;
  slug: string;
  privateKey: string;
  webUrl: string;
  apiUrl: string;
}

export function appConfig(c: Context<AppEnv>): AppConfig {
  const { GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY } = c.env;
  if (!GITHUB_APP_ID?.trim() || !GITHUB_APP_SLUG?.trim() || !GITHUB_APP_PRIVATE_KEY?.trim()) {
    throw new AppError("internal", "GitHub App is not configured (GITHUB_APP_ID / GITHUB_APP_SLUG / GITHUB_APP_PRIVATE_KEY)");
  }
  const gh = githubConfig(c);
  return { appId: GITHUB_APP_ID.trim(), slug: GITHUB_APP_SLUG.trim(), privateKey: GITHUB_APP_PRIVATE_KEY, webUrl: gh.oauthUrl, apiUrl: gh.apiUrl };
}

const b64url = (bytes: Uint8Array | string): string => {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let s = "";
  for (const b of raw) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** DER length bytes. */
function derLen(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

/** Wraps a PKCS#1 RSAPrivateKey in a PKCS#8 envelope; WebCrypto only imports PKCS#8. */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...derLen(pkcs1.length)];
  const inner = [0x02, 0x01, 0x00, ...algorithm, ...octet];
  const total = inner.length + pkcs1.length;
  return new Uint8Array([0x30, ...derLen(total), ...inner, ...pkcs1]);
}

export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  // Secrets set from a shell often carry literal "\n" instead of newlines.
  const text = pem.replace(/\\n/g, "\n");
  const isPkcs1 = text.includes("BEGIN RSA PRIVATE KEY");
  const body = text.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  let der: Uint8Array;
  try {
    der = Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0));
    if (isPkcs1) der = pkcs1ToPkcs8(der);
    return await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch (cause) {
    throw new AppError("internal", `GITHUB_APP_PRIVATE_KEY is not a valid RSA PEM key: ${String(cause)}`, { cause });
  }
}

/** The App JWT (RS256): proves to GitHub that we are the app. `iat` is back-dated a minute for clock drift. */
export async function appJwt(app: AppConfig, now = Date.now()): Promise<string> {
  const iat = Math.floor(now / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iat: iat - 60, exp: iat + 9 * 60, iss: app.appId }));
  const key = await importPrivateKey(app.privateKey);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${claims}`));
  return `${head}.${claims}.${b64url(new Uint8Array(sig))}`;
}

export function ghHeaders(token: string): HeadersInit {
  return { accept: "application/vnd.github+json", "user-agent": "spectrace", "x-github-api-version": "2022-11-28", authorization: `Bearer ${token}` };
}

/** Installation tokens live an hour; they are kept per isolate and reused until they near expiry. */
const TOKEN_SLACK_MS = 5 * 60_000;
const tokenCache = new Map<number, { token: string; expiresAt: number }>();

/** A short-lived token for one installation, or null when GitHub no longer knows the installation. */
export async function installationToken(app: AppConfig, installationId: number): Promise<string | null> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt - TOKEN_SLACK_MS > Date.now()) return cached.token;
  let res: Response;
  try {
    res = await fetch(`${app.apiUrl}/app/installations/${installationId}/access_tokens`, { method: "POST", headers: ghHeaders(await appJwt(app)) });
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError("upstream", `GitHub installation token: ${String(cause)}`, { cause });
  }
  if (res.status === 404) {
    tokenCache.delete(installationId);
    return null;
  }
  if (!res.ok) throw new AppError("upstream", `GitHub installation token: status ${res.status}`);
  const body = (await res.json()) as { token: string; expires_at: string };
  tokenCache.set(installationId, { token: body.token, expiresAt: Date.parse(body.expires_at) });
  return body.token;
}

export async function ghJson<T>(what: string, url: string, token: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: ghHeaders(token) });
  } catch (cause) {
    throw new AppError("upstream", `GitHub ${what}: ${String(cause)}`, { cause });
  }
  if (!res.ok) throw new AppError("upstream", `GitHub ${what}: status ${res.status}`);
  return (await res.json()) as T;
}

const PAGE_SIZE = 100;

/** A repository an installation of the App can reach. */
export interface InstalledRepo {
  id: number;
  installation_id: number;
  owner: string;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  html_url: string;
}

async function installationRepos(app: AppConfig, installationId: number, token: string): Promise<InstalledRepo[]> {
  const out: InstalledRepo[] = [];
  for (let page = 1; ; page++) {
    const batch = await ghJson<{
      repositories: { id: number; name: string; full_name: string; private: boolean; default_branch: string; html_url: string; owner: { login: string } }[];
    }>("repositories request", `${app.apiUrl}/installation/repositories?per_page=${PAGE_SIZE}&page=${page}`, token);
    for (const r of batch.repositories) {
      out.push({
        id: r.id,
        installation_id: installationId,
        owner: r.owner.login,
        name: r.name,
        full_name: r.full_name,
        private: r.private,
        default_branch: r.default_branch,
        html_url: r.html_url,
      });
    }
    if (batch.repositories.length < PAGE_SIZE) return out;
  }
}

/**
 * Every repository the user's installations can reach, sorted by full name. An installation GitHub no
 * longer knows (uninstalled) is forgotten on the way.
 */
export async function userRepos(app: AppConfig, db: D1Database, userId: string): Promise<InstalledRepo[]> {
  const { results } = await db
    .prepare("SELECT installation_id FROM user_installations WHERE user_id = ?1 ORDER BY installation_id")
    .bind(userId)
    .all<{ installation_id: number }>();
  const repos: InstalledRepo[] = [];
  for (const { installation_id } of results) {
    const token = await installationToken(app, installation_id);
    if (!token) {
      await db.prepare("DELETE FROM github_installations WHERE id = ?1").bind(installation_id).run();
      continue;
    }
    repos.push(...(await installationRepos(app, installation_id, token)));
  }
  repos.sort((a, b) => (a.full_name < b.full_name ? -1 : a.full_name > b.full_name ? 1 : 0));
  return repos;
}

export function forgetInstallationTokens() {
  tokenCache.clear();
}

/** The app config for code that runs outside a request (the job queue). */
export function appConfigFromEnv(env: Bindings): AppConfig {
  const { GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY } = env;
  if (!GITHUB_APP_ID?.trim() || !GITHUB_APP_SLUG?.trim() || !GITHUB_APP_PRIVATE_KEY?.trim()) {
    throw new AppError("internal", "GitHub App is not configured (GITHUB_APP_ID / GITHUB_APP_SLUG / GITHUB_APP_PRIVATE_KEY)");
  }
  const origin = (env.GITHUB_OAUTH_URL ?? "https://github.com").replace(/\/+$/, "");
  return {
    appId: GITHUB_APP_ID.trim(),
    slug: GITHUB_APP_SLUG.trim(),
    privateKey: GITHUB_APP_PRIVATE_KEY,
    webUrl: origin,
    apiUrl: (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, ""),
  };
}
