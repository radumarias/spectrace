import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import opened from "./recorded/webhooks/pull_request-opened.json";
import edited from "./recorded/webhooks/pull_request-edited.json";
import synchronize from "./recorded/webhooks/pull_request-synchronize.json";
import closedMerged from "./recorded/webhooks/pull_request-closed-merged.json";
import reviewSubmitted from "./recorded/webhooks/pull_request_review-submitted.json";
import reviewDismissed from "./recorded/webhooks/pull_request_review-dismissed.json";
import suiteRequested from "./recorded/webhooks/check_suite-requested.json";
import suiteCompleted from "./recorded/webhooks/check_suite-completed.json";
import pushFeature from "./recorded/webhooks/push-feature.json";
import pushMain from "./recorded/webhooks/push-main.json";

const SECRET = "whsec-test";

async function sign(body: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `sha256=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

let n = 0;
async function setup() {
  const userId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO users (id, github_id, login) VALUES (?1, ?2, ?3)").bind(userId, 3_000_000 + ++n, `wh${n}-${userId.slice(0, 6)}`).run();
  const projectId = `proj-${userId}`;
  await env.DB.prepare("INSERT INTO projects (id, owner_id, name) VALUES (?1, ?2, 'p')").bind(projectId, userId).run();
  const repoId = crypto.randomUUID();
  // Every test gets its own repo name, so deliveries only reach its own project.
  const fullName = `acme/shop${n}`;
  await env.DB.prepare("INSERT INTO project_repos (id, project_id, full_name) VALUES (?1, ?2, ?3)").bind(repoId, projectId, fullName).run();
  return { projectId, repoId, fullName };
}

/** Send a recorded payload, as GitHub would, with the repository rewritten to the test's own. */
async function deliver(event: string, payload: object, repo: { fullName: string }, opts: { secret?: string; signature?: string | null; delivery?: string } = {}) {
  const body = JSON.stringify({ ...payload, repository: { full_name: repo.fullName } });
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": event,
    "x-github-delivery": opts.delivery ?? crypto.randomUUID(),
  };
  if (opts.signature !== null) headers["x-hub-signature-256"] = opts.signature ?? (await sign(body, opts.secret));
  return exports.default.fetch(new Request("http://spectrace.test/api/github/webhook", { method: "POST", headers, body }));
}

const pr = (repoId: string, number = 7) =>
  env.DB.prepare(
    "SELECT title, state, draft, head_sha, files_sha, additions, deletions, changed_files, github_updated_at, merged_at FROM pull_requests WHERE repo_id = ?1 AND number = ?2",
  )
    .bind(repoId, number)
    .first<Record<string, unknown>>();

const liveEvents = async (projectId: string) =>
  (
    await env.DB.prepare("SELECT event, data FROM job_events WHERE project_id = ?1 AND job_id LIKE 'wh-%' ORDER BY id").bind(projectId).all<{ event: string; data: string }>()
  ).results.map((r) => [r.event, JSON.parse(r.data)]);

const syncJobs = async (projectId: string) =>
  (await env.DB.prepare("SELECT target, state FROM jobs WHERE project_id = ?1 AND kind = 'sync' ORDER BY created_at, rowid").bind(projectId).all()).results;

describe("webhook signature", () => {
  it("refuses a missing, malformed or wrong signature with 401 and stores nothing", async () => {
    const repo = await setup();
    for (const opts of [{ signature: null }, { signature: "sha256=zz" }, { signature: `sha256=${"0".repeat(64)}` }, { secret: "not-the-secret" }]) {
      const res = await deliver("pull_request", opened, repo, opts);
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
    }
    expect(await pr(repo.repoId)).toBeNull();
  });

  it("is checked against the exact bytes sent", async () => {
    const repo = await setup();
    const body = JSON.stringify({ ...opened, repository: { full_name: repo.fullName } });
    const signature = await sign(body);
    const res = await exports.default.fetch(
      new Request("http://spectrace.test/api/github/webhook", {
        method: "POST",
        headers: { "x-github-event": "pull_request", "x-hub-signature-256": signature },
        body: body.replace("coupon", "kupon"),
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("webhook events", () => {
  it("acknowledges events it does not use, and repositories no project has", async () => {
    const repo = await setup();
    const ping = await deliver("ping", { zen: "Keep it logically awesome." }, repo);
    expect(ping.status).toBe(200);
    expect(await ping.json()).toEqual({ ok: true, event: "ping", handled: false });

    const stranger = await deliver("pull_request", opened, { fullName: "nobody/else" });
    expect(stranger.status).toBe(200);
    expect(await stranger.json()).toEqual({ ok: true, event: "pull_request", handled: false });
  });

  it("answers 400 to a signed payload that is not JSON", async () => {
    const body = "not json";
    const res = await exports.default.fetch(
      new Request("http://spectrace.test/api/github/webhook", {
        method: "POST",
        headers: { "x-github-event": "push", "x-hub-signature-256": await sign(body) },
        body,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("replaying a PR's life changes the stored PR, one step at a time", async () => {
    const repo = await setup();
    const { repoId, projectId } = repo;

    expect((await deliver("pull_request", opened, repo)).status).toBe(200);
    expect(await pr(repoId)).toMatchObject({ title: "Add coupon field to checkout", state: "open", head_sha: "aaa111", files_sha: null, additions: 46, changed_files: 2 });
    // Its files are not known yet, so a sync is queued for the repo.
    expect(await syncJobs(projectId)).toEqual([{ target: repo.fullName, state: "queued" }]);

    await deliver("pull_request", edited, repo);
    expect(await pr(repoId)).toMatchObject({ title: "Add coupon field", head_sha: "aaa111" });

    await deliver("pull_request", synchronize, repo);
    expect(await pr(repoId)).toMatchObject({ head_sha: "ccc333", additions: 50, changed_files: 3 });
    // The first sync has not run, so no second one is queued.
    expect(await syncJobs(projectId)).toHaveLength(1);

    await deliver("pull_request", closedMerged, repo);
    expect(await pr(repoId)).toMatchObject({ state: "closed", merged_at: "2026-11-19T13:00:00Z" });

    expect(await liveEvents(projectId)).toEqual([
      ["pr.updated", { repo: repo.fullName, number: 7, cause: "pull_request.opened" }],
      ["pr.updated", { repo: repo.fullName, number: 7, cause: "pull_request.edited" }],
      ["pr.updated", { repo: repo.fullName, number: 7, cause: "pull_request.synchronize" }],
      ["pr.updated", { repo: repo.fullName, number: 7, cause: "pull_request.closed" }],
    ]);
  });

  it("does not let a late, older delivery roll a PR back", async () => {
    const repo = await setup();
    await deliver("pull_request", opened, repo);
    await deliver("pull_request", edited, repo);
    await deliver("pull_request", opened, repo); // redelivered after the edit
    expect(await pr(repo.repoId)).toMatchObject({ title: "Add coupon field" });
    expect(await liveEvents(repo.projectId)).toHaveLength(2); // the stale one changed nothing, so says nothing
  });

  it("stores reviews, lets a dismissal stand, and tells watchers", async () => {
    const repo = await setup();
    await deliver("pull_request", opened, repo);
    await deliver("pull_request_review", reviewSubmitted, repo);
    const mine = async () =>
      (
        await env.DB.prepare("SELECT r.reviewer_login, r.state, r.commit_sha FROM pr_reviews r JOIN pull_requests p ON p.id = r.pull_request_id WHERE p.repo_id = ?1")
          .bind(repo.repoId)
          .all()
      ).results;
    expect(await mine()).toEqual([{ reviewer_login: "hubot", state: "approved", commit_sha: "ccc333" }]);

    await deliver("pull_request_review", reviewDismissed, repo);
    expect(await mine()).toEqual([{ reviewer_login: "hubot", state: "dismissed", commit_sha: "ccc333" }]);

    await deliver("pull_request_review", reviewSubmitted, repo); // a late redelivery of the approval
    expect(await mine()).toEqual([{ reviewer_login: "hubot", state: "dismissed", commit_sha: "ccc333" }]);
    expect((await liveEvents(repo.projectId)).map(([, d]) => (d as { cause: string }).cause)).toContain("pull_request_review.dismissed");
  });

  it("records check suites and tells watchers of the PRs on that commit", async () => {
    const repo = await setup();
    await deliver("pull_request", synchronize, repo); // head is ccc333
    await deliver("check_suite", suiteRequested, repo);
    await deliver("check_suite", suiteCompleted, repo);
    await deliver("check_suite", suiteRequested, repo); // late duplicate of the first one
    const suites = (await env.DB.prepare("SELECT head_sha, app_name, status, conclusion FROM pr_check_suites WHERE repo_id = ?1").bind(repo.repoId).all()).results;
    expect(suites).toEqual([{ head_sha: "ccc333", app_name: "GitHub Actions", status: "completed", conclusion: "success" }]);
    expect((await liveEvents(repo.projectId)).map(([e, d]) => [e, (d as { cause: string }).cause])).toEqual([
      ["pr.updated", "pull_request.synchronize"],
      ["pr.updated", "check_suite.requested"],
      ["pr.updated", "check_suite.completed"],
    ]);

    // A suite for a commit no stored PR has is kept (its PR may arrive later) but announces nothing.
    await deliver("check_suite", { ...suiteCompleted, check_suite: { ...suiteCompleted.check_suite, id: 778, head_sha: "zzz999" } }, repo);
    expect(await liveEvents(repo.projectId)).toHaveLength(3);
  });

  it("moves the head of a PR when its branch is pushed, and queues a sync for the files", async () => {
    const repo = await setup();
    await deliver("pull_request", opened, repo);
    // Pretend the first sync already read the files for aaa111.
    await env.DB.prepare("UPDATE pull_requests SET files_sha = 'aaa111' WHERE repo_id = ?1").bind(repo.repoId).run();
    await env.DB.prepare("UPDATE jobs SET state = 'succeeded' WHERE project_id = ?1").bind(repo.projectId).run();

    await deliver("push", pushFeature, repo);
    expect(await pr(repo.repoId)).toMatchObject({ head_sha: "ccc333", files_sha: "aaa111" });
    expect(await syncJobs(repo.projectId)).toEqual([
      { target: repo.fullName, state: "succeeded" },
      { target: repo.fullName, state: "queued" },
    ]);

    // The same push again changes nothing (the head already moved).
    await deliver("push", pushFeature, repo);
    expect(await syncJobs(repo.projectId)).toHaveLength(2);

    // A push to another branch only announces itself.
    await deliver("push", pushMain, repo);
    const events = await liveEvents(repo.projectId);
    expect(events.at(-1)).toEqual(["repo.pushed", { repo: repo.fullName, branch: "main", sha: "000bbb" }]);
  });

  it("serves the same recorded delivery twice without duplicating rows", async () => {
    const repo = await setup();
    const delivery = crypto.randomUUID();
    await deliver("pull_request", opened, repo, { delivery });
    await deliver("pull_request", opened, repo, { delivery });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM pull_requests WHERE repo_id = ?1").bind(repo.repoId).first<{ n: number }>())?.n).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE project_id = ?1 AND kind = 'webhook'").bind(repo.projectId).first<{ n: number }>())?.n).toBe(1);
  });
});
