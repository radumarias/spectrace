// GitHub App webhooks (T2.2): `POST /api/github/webhook`.
//
// GitHub signs each delivery with the App's webhook secret
// (`X-Hub-Signature-256: sha256=<hex HMAC of the raw body>`). A delivery with
// a missing or wrong signature is refused with 401 before anything is read.
// Handled events update the stored pull requests (`pull_request`,
// `pull_request_review`, `check_suite`, `check_run`, `push`); each stored change is
// announced to the project's live feed as a `pr.updated` or `repo.pushed`
// event, and a PR whose files are out of date queues a `sync` job.
//
// Every update is safe to repeat and to receive out of order, because GitHub
// redelivers and does not promise ordering.
import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv, Bindings } from "../env";
import { AppError, ErrorBody } from "../error";
import { enqueueIndex, INDEX_KIND } from "../jobs/index-repo";
import { emit, enqueueJob } from "../jobs/queue";
import { SYNC_KIND } from "../jobs/sync";
import { log } from "../log";
import { checkRunStatement, type GhCheckRun } from "../checks";
import { upsertPullFromWebhook, type GhPull } from "../pulls";

const MAX_BODY_BYTES = 26 * 1024 * 1024; // GitHub's own cap is 25 MB

const Result = z.object({ ok: z.literal(true), event: z.string(), handled: z.boolean() }).openapi("WebhookResult");

const route = createRoute({
  method: "post",
  path: "/api/github/webhook",
  summary: "GitHub App webhook receiver",
  description:
    "Called by GitHub, not by the web app. Needs `X-Hub-Signature-256`, `X-GitHub-Event` and `X-GitHub-Delivery`. " +
    "Handles `pull_request`, `pull_request_review`, `check_suite`, `check_run` and `push`; other events are acknowledged and ignored.",
  responses: {
    200: { description: "Accepted (`handled` is false for events we do not use)", content: { "application/json": { schema: Result } } },
    400: { description: "Not a JSON payload", content: { "application/json": { schema: ErrorBody } } },
    401: { description: "Signature missing or wrong", content: { "application/json": { schema: ErrorBody } } },
    500: { description: "Webhook secret not configured", content: { "application/json": { schema: ErrorBody } } },
  },
});

const hexToBytes = (hex: string): Uint8Array<ArrayBuffer> => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));

/** HMAC-SHA256 check through WebCrypto; `subtle.verify` compares in constant time. */
export async function validSignature(secret: string, body: ArrayBuffer, header: string | undefined): Promise<boolean> {
  const hex = /^sha256=([0-9a-f]{64})$/i.exec(header ?? "")?.[1];
  if (!hex) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, hexToBytes(hex), body);
}

interface RepoRow {
  id: string;
  project_id: string;
  full_name: string;
  default_branch: string;
}

/** What changed, as a live event for the project. */
interface Change {
  event: "pr.updated" | "repo.pushed";
  data: Record<string, unknown>;
}

interface Payload {
  action?: string;
  repository?: { full_name?: string };
  pull_request?: GhPull;
  review?: { id: number; user: { login: string } | null; state: string; body: string | null; commit_id: string; submitted_at: string | null };
  check_suite?: { id: number; head_sha: string; status: string; conclusion: string | null; updated_at: string; app?: { name?: string } | null };
  check_run?: GhCheckRun;
  ref?: string;
  before?: string;
  after?: string;
  deleted?: boolean;
}

const prChange = (repo: RepoRow, number: number, cause: string): Change => ({ event: "pr.updated", data: { repo: repo.full_name, number, cause } });

/** Queue a sync for the repo unless one is already waiting (it will see the newest state). */
async function requestSync(env: Bindings, repo: RepoRow): Promise<void> {
  const waiting = await env.DB.prepare("SELECT 1 AS x FROM jobs WHERE project_id = ?1 AND kind = ?2 AND target = ?3 AND state = 'queued' LIMIT 1")
    .bind(repo.project_id, SYNC_KIND, repo.full_name)
    .first();
  if (waiting) return;
  try {
    await enqueueJob(env, repo.project_id, SYNC_KIND, repo.full_name);
  } catch (error) {
    // The PR row is already updated; a manual sync catches up. Do not make GitHub redeliver over it.
    log("warn", "webhook could not queue a sync", { repo: repo.full_name, error: String(error) }, env.LOG_FORMAT);
  }
}

/** One waiting index job per repo is enough: it reads the branch as it is when it runs. */
async function requestIndex(env: Bindings, repo: RepoRow): Promise<void> {
  const waiting = await env.DB.prepare("SELECT 1 AS x FROM jobs WHERE project_id = ?1 AND kind = ?2 AND target = ?3 AND state = 'queued' LIMIT 1")
    .bind(repo.project_id, INDEX_KIND, repo.id)
    .first();
  if (waiting) return;
  try {
    await enqueueIndex(env, repo.project_id, repo.id);
  } catch (error) {
    log("warn", "webhook could not queue an index", { repo: repo.full_name, error: String(error) }, env.LOG_FORMAT);
  }
}

async function onPullRequest(env: Bindings, repo: RepoRow, p: Payload): Promise<Change[] | null> {
  if (!p.pull_request) return null;
  const stored = await upsertPullFromWebhook(env, repo.id, p.pull_request);
  if (stored.filesStale) await requestSync(env, repo);
  return stored.changed ? [prChange(repo, p.pull_request.number, `pull_request.${p.action ?? "updated"}`)] : [];
}

async function onReview(env: Bindings, repo: RepoRow, p: Payload): Promise<Change[] | null> {
  if (!p.pull_request || !p.review) return null;
  const { review } = p;
  // The payload carries the whole PR, so a review for a PR we have not seen yet stores it too.
  const stored = await upsertPullFromWebhook(env, repo.id, p.pull_request);
  if (stored.filesStale) await requestSync(env, repo);
  const res = await env.DB.prepare(
    `INSERT INTO pr_reviews (pull_request_id, github_review_id, reviewer_login, state, body, commit_sha, submitted_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (pull_request_id, github_review_id) DO UPDATE SET
       state = excluded.state, body = excluded.body, commit_sha = excluded.commit_sha, submitted_at = excluded.submitted_at
     WHERE ?8 = 'dismissed' OR pr_reviews.state != 'dismissed'`,
  )
    .bind(stored.id, review.id, review.user?.login ?? "", review.state.toLowerCase(), review.body ?? "", review.commit_id, review.submitted_at ?? p.pull_request.updated_at, p.action ?? "")
    .run();
  return stored.changed || res.meta.changes > 0 ? [prChange(repo, p.pull_request.number, `pull_request_review.${p.action ?? "updated"}`)] : [];
}

async function onCheckSuite(env: Bindings, repo: RepoRow, p: Payload): Promise<Change[] | null> {
  const suite = p.check_suite;
  if (!suite) return null;
  const res = await env.DB.prepare(
    `INSERT INTO pr_check_suites (repo_id, github_check_suite_id, head_sha, app_name, status, conclusion, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (repo_id, github_check_suite_id) DO UPDATE SET
       head_sha = excluded.head_sha, app_name = excluded.app_name, status = excluded.status, conclusion = excluded.conclusion, updated_at = excluded.updated_at
     WHERE excluded.updated_at >= pr_check_suites.updated_at`,
  )
    .bind(repo.id, suite.id, suite.head_sha, suite.app?.name ?? "", suite.status, suite.conclusion, suite.updated_at)
    .run();
  if (res.meta.changes === 0) return [];
  const { results } = await env.DB.prepare("SELECT number FROM pull_requests WHERE repo_id = ?1 AND head_sha = ?2 ORDER BY number")
    .bind(repo.id, suite.head_sha)
    .all<{ number: number }>();
  return results.map((r) => prChange(repo, r.number, `check_suite.${p.action ?? "updated"}`));
}

async function onCheckRun(env: Bindings, repo: RepoRow, p: Payload): Promise<Change[] | null> {
  const run = p.check_run;
  if (!run) return null;
  const res = await checkRunStatement(env, repo.id, run).run();
  if (res.meta.changes === 0) return [];
  const { results } = await env.DB.prepare("SELECT number FROM pull_requests WHERE repo_id = ?1 AND head_sha = ?2 ORDER BY number")
    .bind(repo.id, run.head_sha)
    .all<{ number: number }>();
  return results.map((r) => prChange(repo, r.number, `check_run.${p.action ?? "updated"}`));
}

const BRANCH = "refs/heads/";

async function onPush(env: Bindings, repo: RepoRow, p: Payload): Promise<Change[] | null> {
  if (!p.ref?.startsWith(BRANCH) || !p.after) return null;
  const branch = p.ref.slice(BRANCH.length);
  if (p.deleted) return [];
  const changes: Change[] = [{ event: "repo.pushed", data: { repo: repo.full_name, branch, sha: p.after } }];
  // Move the head of open PRs on this branch. Matching on the old sha leaves
  // alone a fork's PR whose branch merely has the same name. Files are read
  // by the sync, which `files_sha` (still the old head) makes due.
  const { results } = await env.DB.prepare(
    `UPDATE pull_requests SET head_sha = ?3, synced_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE repo_id = ?1 AND state = 'open' AND head_ref = ?2 AND head_sha = ?4 RETURNING number`,
  )
    .bind(repo.id, branch, p.after, p.before ?? "")
    .all<{ number: number }>();
  if (results.length > 0) await requestSync(env, repo);
  for (const { number } of results) changes.push(prChange(repo, number, "push"));
  // Specs and anchors are read from the default branch: a push there re-indexes the repo (T4.4).
  if (branch === repo.default_branch) await requestIndex(env, repo);
  return changes;
}

const HANDLERS: Record<string, (env: Bindings, repo: RepoRow, p: Payload) => Promise<Change[] | null>> = {
  pull_request: onPullRequest,
  pull_request_review: onReview,
  check_suite: onCheckSuite,
  check_run: onCheckRun,
  push: onPush,
};

/** Webhook changes ride on a finished "webhook" job per project and delivery, so they reach the live feed and its replay. */
async function announce(env: Bindings, projectId: string, delivery: string, event: string, changes: Change[]): Promise<void> {
  if (changes.length === 0) return;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${delivery}:${projectId}`));
  const id = `wh-${[...new Uint8Array(digest).slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  const now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
  await env.DB.prepare(
    `INSERT OR IGNORE INTO jobs (id, project_id, kind, target, state, attempts, max_attempts, finished_at)
     VALUES (?1, ?2, 'webhook', ?3, 'succeeded', 1, 1, ${now})`,
  )
    .bind(id, projectId, event)
    .run();
  for (const change of changes) await emit(env, { id, project_id: projectId }, change.event, change.data);
}

export function registerWebhook(app: OpenAPIHono<AppEnv>) {
  app.openapi(route, async (c) => {
    const secret = c.env.GITHUB_WEBHOOK_SECRET?.trim();
    if (!secret) throw new AppError("internal", "GitHub webhook secret is not configured (GITHUB_WEBHOOK_SECRET)");

    const body = await c.req.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES || !(await validSignature(secret, body, c.req.header("x-hub-signature-256")))) {
      throw AppError.unauthorized("bad webhook signature");
    }

    const event = c.req.header("x-github-event") ?? "";
    const delivery = c.req.header("x-github-delivery") ?? "";
    const handler = HANDLERS[event];
    if (!handler) return c.json({ ok: true as const, event, handled: false }, 200);

    let payload: Payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(body)) as Payload;
    } catch {
      throw AppError.badRequest("payload is not JSON");
    }
    if (typeof payload !== "object" || payload === null) throw AppError.badRequest("payload is not an object");

    const fullName = payload.repository?.full_name;
    const { results: repos } = fullName
      ? await c.env.DB.prepare("SELECT id, project_id, full_name, default_branch FROM project_repos WHERE full_name = ?1 AND provider = 'github'").bind(fullName).all<RepoRow>()
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
