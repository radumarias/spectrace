// GitLab webhooks: `POST /api/gitlab/webhook`.
//
// GitLab sends the hook's secret token as `X-Gitlab-Token`; a delivery
// without the right one is refused with 401 before anything is read. The
// index job adds the hook to each GitLab project (merge request, push,
// pipeline and job events) with GITLAB_WEBHOOK_SECRET as its token.
//
// A merge request event reads the MR from the API (hooks leave out the
// author) and stores it like the GitHub `pull_request` event does; a push
// moves PR heads and re-indexes the default branch; pipeline and job events
// store check runs. Safe to repeat and to receive out of order.
import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { checkRunStatement, type GhCheckRun } from "../checks";
import type { AppEnv, Bindings } from "../env";
import { AppError, ErrorBody } from "../error";
import { gitlabFor, storeApprovals, toCheckRun } from "../git/gitlab";
import { log } from "../log";
import { upsertPullFromWebhook } from "../pulls";
import { announce, onPush, prChange, requestSync, type Change, type RepoRow } from "./webhook";

const MAX_BODY_BYTES = 26 * 1024 * 1024;

const Result = z.object({ ok: z.literal(true), event: z.string(), handled: z.boolean() }).openapi("GitlabWebhookResult");

const route = createRoute({
  method: "post",
  path: "/api/gitlab/webhook",
  summary: "GitLab webhook receiver",
  description:
    "Called by GitLab, not by the web app. Needs `X-Gitlab-Token` and `X-Gitlab-Event`. Handles merge request, push, pipeline and job events; other events are acknowledged and ignored.",
  responses: {
    200: { description: "Accepted (`handled` is false for events we do not use)", content: { "application/json": { schema: Result } } },
    400: { description: "Not a JSON payload", content: { "application/json": { schema: ErrorBody } } },
    401: { description: "Token missing or wrong", content: { "application/json": { schema: ErrorBody } } },
    500: { description: "Webhook secret not configured", content: { "application/json": { schema: ErrorBody } } },
  },
});

/** Constant-time comparison through HMAC: equal inputs give equal digests, and `verify` compares in constant time. */
async function sameToken(secret: string, given: string | undefined): Promise<boolean> {
  if (!given) return false;
  const key = await crypto.subtle.importKey("raw", crypto.getRandomValues(new Uint8Array(32)), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(secret));
  return crypto.subtle.verify("HMAC", key, mac, new TextEncoder().encode(given));
}

/** Hooks write times as `2026-11-26 10:00:00 UTC` or `+0100`; the API and D1 use ISO 8601. */
export function isoTime(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = Date.parse(s.replace(/^(\d{4}-\d\d-\d\d) /, "$1T").replace(/ UTC$/, "Z").replace(/ ([+-]\d\d):?(\d\d)$/, "$1:$2"));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

interface Payload {
  object_kind?: string;
  project?: { path_with_namespace?: string; web_url?: string };
  object_attributes?: { iid?: number; action?: string; id?: number; sha?: string; status?: string };
  builds?: { id: number; name: string; status: string; allow_failure?: boolean; started_at?: string | null; finished_at?: string | null }[];
  // push
  ref?: string;
  before?: string;
  after?: string;
  // job
  build_id?: number;
  build_name?: string;
  build_status?: string;
  build_allow_failure?: boolean;
  build_started_at?: string | null;
  build_finished_at?: string | null;
  sha?: string;
}

const ZERO_SHA = /^0+$/;

async function onMergeRequest(env: Bindings, repo: RepoRow, p: Payload): Promise<Change[] | null> {
  const iid = p.object_attributes?.iid;
  if (typeof iid !== "number") return null;
  try {
    const client = await gitlabFor(env, repo.project_id, repo.full_name, "sync");
    const pr = await client.pull(iid);
    if (!pr) return [];
    const stored = await upsertPullFromWebhook(env, repo.id, pr);
    await storeApprovals(env, client, stored.id, iid, pr.head.sha, pr.updated_at);
    if (stored.filesStale) await requestSync(env, repo);
    // Approvals do not move `updated_at`, so an approval event is always news.
    const approval = /approv/.test(p.object_attributes?.action ?? "");
    return stored.changed || approval ? [prChange(repo, iid, `merge_request.${p.object_attributes?.action ?? "update"}`)] : [];
  } catch (error) {
    // No account or GitLab down: the sync reads it later.
    log("warn", "GitLab webhook could not read the merge request", { repo: repo.full_name, iid, error: String(error) }, env.LOG_FORMAT);
    await requestSync(env, repo);
    return [];
  }
}

function onGitlabPush(env: Bindings, repo: RepoRow, p: Payload): Promise<Change[] | null> {
  return onPush(env, repo, { ref: p.ref, before: p.before, after: p.after, deleted: ZERO_SHA.test(p.after ?? "") });
}

async function storeRuns(env: Bindings, repo: RepoRow, sha: string, runs: GhCheckRun[], cause: string): Promise<Change[]> {
  if (runs.length === 0) return [];
  const res = await env.DB.batch(runs.map((r) => checkRunStatement(env, repo.id, r)));
  if (!res.some((r) => r.meta.changes > 0)) return [];
  const { results } = await env.DB.prepare("SELECT number FROM pull_requests WHERE repo_id = ?1 AND head_sha = ?2 ORDER BY number").bind(repo.id, sha).all<{ number: number }>();
  return results.map((r) => prChange(repo, r.number, cause));
}

const jobUrl = (p: Payload, id: number) => (p.project?.web_url ? `${p.project.web_url}/-/jobs/${id}` : "");

async function onPipeline(env: Bindings, repo: RepoRow, p: Payload): Promise<Change[] | null> {
  const sha = p.object_attributes?.sha;
  if (!sha || !p.builds) return null;
  const runs = p.builds.map((b) =>
    toCheckRun({ ...b, web_url: jobUrl(p, b.id), started_at: isoTime(b.started_at), finished_at: isoTime(b.finished_at) }, sha),
  );
  return storeRuns(env, repo, sha, runs, `pipeline.${p.object_attributes?.status ?? "updated"}`);
}

async function onJob(env: Bindings, repo: RepoRow, p: Payload): Promise<Change[] | null> {
  if (typeof p.build_id !== "number" || !p.sha || !p.build_name || !p.build_status) return null;
  const run = toCheckRun(
    {
      id: p.build_id,
      name: p.build_name,
      status: p.build_status,
      allow_failure: p.build_allow_failure,
      web_url: jobUrl(p, p.build_id),
      started_at: isoTime(p.build_started_at),
      finished_at: isoTime(p.build_finished_at),
    },
    p.sha,
  );
  return storeRuns(env, repo, p.sha, [run], `job.${p.build_status}`);
}

const HANDLERS: Record<string, (env: Bindings, repo: RepoRow, p: Payload) => Promise<Change[] | null>> = {
  "Merge Request Hook": onMergeRequest,
  "Push Hook": onGitlabPush,
  "Pipeline Hook": onPipeline,
  "Job Hook": onJob,
};

export function registerGitlabWebhook(app: OpenAPIHono<AppEnv>) {
  app.openapi(route, async (c) => {
    const secret = c.env.GITLAB_WEBHOOK_SECRET?.trim();
    if (!secret) throw new AppError("internal", "GitLab webhook secret is not configured (GITLAB_WEBHOOK_SECRET)");
    const body = await c.req.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES || !(await sameToken(secret, c.req.header("x-gitlab-token")))) throw AppError.unauthorized("bad webhook token");

    const event = c.req.header("x-gitlab-event") ?? "";
    const delivery = c.req.header("x-gitlab-event-uuid") ?? c.req.header("x-gitlab-webhook-uuid") ?? crypto.randomUUID();
    const handler = HANDLERS[event];
    if (!handler) return c.json({ ok: true as const, event, handled: false }, 200);

    let payload: Payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(body)) as Payload;
    } catch {
      throw AppError.badRequest("payload is not JSON");
    }
    if (typeof payload !== "object" || payload === null) throw AppError.badRequest("payload is not an object");

    const fullName = payload.project?.path_with_namespace;
    const { results: repos } = fullName
      ? await c.env.DB.prepare("SELECT id, project_id, full_name, default_branch FROM project_repos WHERE full_name = ?1 COLLATE NOCASE AND provider = 'gitlab'")
          .bind(fullName)
          .all<RepoRow>()
      : { results: [] as RepoRow[] };

    let handled = false;
    for (const repo of repos) {
      const changes = await handler(c.env, repo, payload);
      if (changes === null) continue;
      handled = true;
      await announce(c.env, repo.project_id, delivery, event, changes);
    }
    return c.json({ ok: true as const, event, handled }, 200);
  });
}
