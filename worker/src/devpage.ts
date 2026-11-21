// devpage server (radumarias/devpage, `devpage server`) renders each spec as a
// devpage document: published from the index job, read at `/d/<id>/` on this
// origin. In production it runs as a Cloudflare Container (`DevpageServer`,
// image `containers/devpage/Dockerfile`) with its versions in an R2 bucket.
// `DEVPAGE_ORIGIN` points at a server run some other way instead (a local
// `devpage server`, or a fake in tests). Without either, devpage is off: specs
// are not published and the app shows its own rendering.
import type { Context, Hono } from "hono";
import { requireUser } from "./auth";
import type { AppEnv, Bindings } from "./env";
import { AppError } from "./error";
import { log } from "./log";
import { zipOf } from "./zip";

/** The header devpage server reads each write's author from (`DEVPAGE_USER_HEADER`). */
export const AUTHOR_HEADER = "x-spectrace-user";

/** The container's environment, from the Worker's (see docs/deploy.md). */
export function devpageEnv(env: Bindings): Record<string, string> {
  const out: Record<string, string> = { DEVPAGE_USER_HEADER: AUTHOR_HEADER };
  for (const k of ["DEVPAGE_BUCKET_URL", "AWS_ENDPOINT_URL", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"] as const) {
    const v = env[k];
    if (v) out[k] = v;
  }
  out.AWS_REGION ??= "auto";
  return out;
}

/** Whether a devpage server is reachable from here. */
export const devpageOn = (env: Bindings) => !!env.DEVPAGE_ORIGIN || (!!env.DEVPAGE && !!env.DEVPAGE_BUCKET_URL);

/** Sends `req` (any URL; only its path and query are kept) to devpage server. */
export async function devpageFetch(env: Bindings, path: string, init: RequestInit | Request): Promise<Response> {
  if (env.DEVPAGE_ORIGIN) return fetch(new Request(`${env.DEVPAGE_ORIGIN}${path}`, init));
  if (env.DEVPAGE && env.DEVPAGE_BUCKET_URL) return env.DEVPAGE.getByName("main").fetch(new Request(`http://devpage${path}`, init));
  throw new AppError("not_configured", "devpage server is not configured");
}

const Published = (v: unknown): v is { id: string; version: number } =>
  typeof v === "object" && v !== null && typeof (v as { id?: unknown }).id === "string" && typeof (v as { version?: unknown }).version === "number";

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type PublishRow = { id: string; path: string; flow: string; source: string; devpage_id: string | null; devpage_hash: string | null };

/**
 * Publishes each of the repo's specs whose source changed since its last
 * publish: version 1 of a new document, or the next version of its own.
 * Best effort: a spec devpage refuses keeps its last version, and the index
 * is not failed for it.
 */
export async function publishSpecs(env: Bindings, repoId: string, author: string): Promise<{ published: number; failed: number }> {
  if (!devpageOn(env)) return { published: 0, failed: 0 };
  const { results } = await env.DB.prepare("SELECT id, path, flow, source, devpage_id, devpage_hash FROM specs WHERE repo_id = ?1").bind(repoId).all<PublishRow>();
  let published = 0;
  let failed = 0;
  for (const s of results) {
    const hash = await sha256(s.source);
    if (s.devpage_id && s.devpage_hash === hash) continue;
    const entry = `${s.flow}.md`;
    const path = s.devpage_id ? `/api/documents/${s.devpage_id}/versions?entry=${encodeURIComponent(entry)}` : `/api/documents?entry=${encodeURIComponent(entry)}`;
    try {
      const res = await devpageFetch(env, path, {
        method: "POST",
        headers: { "content-type": "application/zip", [AUTHOR_HEADER]: author },
        body: zipOf([{ path: entry, text: s.source }]),
      });
      const body: unknown = await res.json().catch(async () => res.text());
      if (res.status !== 201 || !Published(body)) throw new Error(`devpage answered ${res.status}: ${JSON.stringify(body).slice(0, 500)}`);
      await env.DB.prepare("UPDATE specs SET devpage_id = ?2, devpage_version = ?3, devpage_hash = ?4 WHERE id = ?1").bind(s.id, body.id, body.version, hash).run();
      published++;
    } catch (error) {
      failed++;
      log("warn", "could not publish spec to devpage", { specId: s.id, path: s.path, error: String(error) }, env.LOG_FORMAT);
    }
  }
  return { published, failed };
}

const DOC = /^\/d\/([0-9a-f-]{36})(?:\/|$)/;

/**
 * `/d/<id>/…` and `/__devpage/<asset>` are devpage server's pages, proxied for
 * a signed-in user, and only for a document that is a spec of one of their
 * projects. WebSocket upgrades (live reload) go through as they are.
 */
export function registerDevpage(app: Hono<AppEnv>) {
  const proxy = async (c: Context<AppEnv>) => {
    const user = await requireUser(c);
    const url = new URL(c.req.url);
    const m = DOC.exec(url.pathname);
    if (m) {
      const own = await c.env.DB.prepare("SELECT 1 FROM specs s JOIN projects p ON p.id = s.project_id WHERE s.devpage_id = ?1 AND p.owner_id = ?2")
        .bind(m[1], user.id)
        .first();
      if (!own) throw AppError.notFound(url.pathname);
    }
    if (!devpageOn(c.env)) throw new AppError("not_configured", "devpage server is not configured");
    const req = new Request(c.req.raw);
    req.headers.delete("cookie");
    req.headers.set(AUTHOR_HEADER, user.login);
    return devpageFetch(c.env, url.pathname + url.search, req);
  };
  app.all("/d/*", proxy);
  app.all("/__devpage/*", proxy);
}
