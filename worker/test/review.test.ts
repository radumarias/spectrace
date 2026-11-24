import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { hashToken } from "../src/auth";
import { MODELS } from "../src/ai";
import { JOBS_QUEUE, type JobMessage } from "../src/jobs/queue";
import { parseFinderAnswer, parseJsonObject, parseVerdict, REVIEW_KIND } from "../src/jobs/review";
import { SHOP } from "./fixtures";

// Claude is never called: Claude Code (http://claude-code.test) and Anthropic
// (http://anthropic.test) are answered by a fake reviewer. The PR plants one
// real bug (a fresh idempotency key on every payment attempt, against the
// spec's "one idempotency key per order") and the finder also raises one
// false alarm; the refuter must keep the first and drop the second.

const PLANTED_PATCH = `@@ -12,7 +12,7 @@ pub fn collect_details(o: &mut Order, form: Form) -> Result<State> {
 #[spec("checkout.pay")]
 pub async fn pay(o: &mut Order) -> Result<State> {
     // @flow checkout.pay: one idempotency key per order
-    let key = o.idempotency_key();
+    let key = Uuid::new_v4().to_string();
     match gateway::charge(o.total, &key).await? {
         Charge::Ok(id) => {
             o.charge_id = Some(id);`;

const BUG = {
  severity: "high",
  path: "src/checkout.rs",
  line: 15,
  title: "A new idempotency key on every payment attempt",
  body: "pay() makes a fresh UUID per call, so a retried charge is not deduplicated by the gateway; the spec requires one key per order.",
  suggested_fix: "Keep using o.idempotency_key().",
  spec: "spec/checkout.md",
};
const FALSE_ALARM = {
  severity: "medium",
  path: "src/checkout.rs",
  line: 3,
  title: "MAX_RETRIES as u8 can overflow",
  body: "The retry counter might wrap.",
  suggested_fix: "Use u32.",
  spec: null,
};

type Call = { origin: string; body: Record<string, unknown> };
let calls: Call[];
let finderAnswer: string;

/** The text of the prompt in a Claude Code or Messages API request body. */
const promptOf = (c: Call) => (c.origin === "http://claude-code.test" ? String(c.body.prompt) : String((c.body.messages as { content: string }[])[0]!.content));
const systemOf = (c: Call) => String(c.body.system ?? "");

function fakeClaude() {
  const real = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    if (url.origin !== "http://claude-code.test" && url.origin !== "http://anthropic.test") return real(input, init);
    const call: Call = { origin: url.origin, body: (await req.json()) as Record<string, unknown> };
    calls.push(call);
    let text: string;
    if (systemOf(call).includes("refuter")) {
      const real = promptOf(call).includes(BUG.title);
      text = JSON.stringify({ real, reason: real ? "The diff replaces the per-order key with a random one." : "The counter is capped at 3 and never near 255." });
    } else {
      text = finderAnswer;
    }
    if (call.origin === "http://claude-code.test") {
      return Response.json({ result: text, isError: false, model: MODELS.opus, numTurns: 1, durationMs: 10, costUsd: 0, usage: {}, sessionId: "s" });
    }
    return Response.json({ id: "msg", model: String(call.body.model), stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 } });
  });
}

let n = 0;
async function seed() {
  const login = `review-${++n}-${crypto.randomUUID().slice(0, 8)}`;
  const userId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO users (id, github_id, login) VALUES (?1, ?2, ?3)").bind(userId, 8_000_000 + n, login).run();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(crypto.randomUUID(), userId, await hashToken(login), new Date(Date.now() + 86_400_000).toISOString())
    .run();
  const projectId = `proj-${userId}`;
  await env.DB.prepare("INSERT INTO projects (id, owner_id, name, context) VALUES (?1, ?2, 'shop', 'A web shop. Payments go through one gateway.')").bind(projectId, userId).run();
  const repoId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO project_repos (id, project_id, full_name) VALUES (?1, ?2, 'acme/shop')").bind(repoId, projectId).run();
  const specId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO specs (id, project_id, repo_id, path, root, area, flow, title, source) VALUES (?1, ?2, ?3, 'spec/checkout.md', '', '', 'checkout', 'Checkout', ?4)")
    .bind(specId, projectId, repoId, SHOP["spec/checkout.md"])
    .run();
  await env.DB.prepare("INSERT INTO anchors (repo_id, spec_id, path, line, language, kind, class, target) VALUES (?1, ?2, 'src/checkout.rs', 12, 'rust', 'spec', 'code', 'checkout.pay')")
    .bind(repoId, specId)
    .run();
  const pullId = `pr-${repoId}`;
  await env.DB.prepare(
    `INSERT INTO pull_requests (id, repo_id, number, github_pr_id, title, body, author_login, state, head_ref, head_sha, base_ref, html_url, github_created_at, github_updated_at)
     VALUES (?1, ?2, 9, ?3, 'Retry payments', 'Make retries safer.', 'mona', 'open', 'feat', 'sha9', 'main', 'https://github.com/acme/shop/pull/9', '2026-11-01T00:00:00Z', '2026-11-10T00:00:00Z')`,
  )
    .bind(pullId, repoId, 90_000 + n)
    .run();
  await env.DB.prepare("INSERT INTO pr_files (pull_request_id, path, status, additions, deletions, patch) VALUES (?1, 'src/checkout.rs', 'modified', 1, 1, ?2)").bind(pullId, PLANTED_PATCH).run();
  return { login, userId, projectId, pullId, cookie: `spectrace_session=${login}`, path: `/api/projects/${projectId}/pulls/${pullId}/agent-review` };
}
type Seed = Awaited<ReturnType<typeof seed>>;

const call = (s: Seed, method = "GET", cookie: string | null = s.cookie) =>
  exports.default.fetch(new Request(`http://spectrace.test${s.path}`, { method, headers: cookie ? { cookie } : {} }));

/** A review row and its job, as POST makes them, without the queue send (tests deliver by hand). */
async function queued(s: Seed, maxAttempts = 2) {
  const reviewId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO reviews (id, pull_request_id, requested_by, head_sha) VALUES (?1, ?2, ?3, 'sha9')").bind(reviewId, s.pullId, s.userId).run();
  await env.DB.prepare("INSERT INTO jobs (id, project_id, kind, target, max_attempts) VALUES (?1, ?2, ?3, ?4, ?5)").bind(jobId, s.projectId, REVIEW_KIND, reviewId, maxAttempts).run();
  await env.DB.prepare("UPDATE reviews SET job_id = ?2 WHERE id = ?1").bind(reviewId, jobId).run();
  return { reviewId, jobId };
}

async function deliver(jobId: string) {
  const batch = createMessageBatch<JobMessage>(JOBS_QUEUE, [{ id: `m-${crypto.randomUUID()}`, timestamp: Date.now(), attempts: 1, body: { jobId } }]);
  const ctx = createExecutionContext();
  await worker.queue(batch, env);
  return getQueueResult(batch, ctx);
}

interface ReviewBody {
  review: {
    id: string;
    state: string;
    stage: string;
    walkthrough: string;
    summary: string;
    risk: string | null;
    riskReason: string;
    steps: { title: string; paths: string[]; spec: string | null; impact: string; change: string; effect: string; code: string }[];
    decisions: string[];
    backend: string | null;
    error: string | null;
    dropped: number;
    findings: { severity: string; title: string; path: string; line: number | null; suggestedFix: string; spec: string | null }[];
  } | null;
}

let spy: ReturnType<typeof fakeClaude>;
beforeEach(() => {
  calls = [];
  finderAnswer = "Here is my review:\n```json\n" + JSON.stringify({
    summary: "Pay makes a fresh idempotency key on every attempt.",
    risk: "high",
    risk_reason: "A retry can charge the card twice.",
    steps: [
      { title: "Pay", paths: ["src/checkout.rs"], spec: "checkout.pay", impact: "high", change: "pay() makes its own key.", effect: "Retries are no longer idempotent.", code: "- let key = o.idempotency_key();\n+ let key = Uuid::new_v4();" },
    ],
    decisions: ["Should a retry reuse the order's key?"],
    walkthrough: "- `src/checkout.rs`: pay() now makes its own key.",
    findings: [FALSE_ALARM, BUG],
  }) + "\n```";
  spy = fakeClaude();
});
afterEach(() => {
  spy.mockRestore();
  env.CLAUDE_CODE_OWNER = undefined;
  env.ANTHROPIC_API_KEY = undefined;
});

describe("review job", () => {
  it("lists the planted bug and drops the planted false alarm", async () => {
    const s = await seed();
    env.ANTHROPIC_API_KEY = "sk-ant-test";
    const { jobId } = await queued(s);
    await deliver(jobId);

    const job = await env.DB.prepare("SELECT state, error FROM jobs WHERE id = ?1").bind(jobId).first<{ state: string; error: string | null }>();
    expect(job).toEqual({ state: "succeeded", error: null });

    const body = (await (await call(s)).json()) as ReviewBody;
    expect(body.review).toMatchObject({ state: "succeeded", stage: "done", backend: "api", dropped: 1, error: null });
    expect(body.review!.walkthrough).toContain("src/checkout.rs");
    expect(body.review).toMatchObject({
      summary: "Pay makes a fresh idempotency key on every attempt.",
      risk: "high",
      riskReason: "A retry can charge the card twice.",
      decisions: ["Should a retry reuse the order's key?"],
    });
    expect(body.review!.steps).toEqual([
      { title: "Pay", paths: ["src/checkout.rs"], spec: "checkout.pay", impact: "high", change: "pay() makes its own key.", effect: "Retries are no longer idempotent.", code: "- let key = o.idempotency_key();\n+ let key = Uuid::new_v4();" },
    ]);
    expect(body.review!.findings).toEqual([
      expect.objectContaining({ severity: "high", title: BUG.title, path: "src/checkout.rs", line: 15, suggestedFix: BUG.suggested_fix, spec: "spec/checkout.md" }),
    ]);

    // One finder, one refuter per finding.
    expect(calls).toHaveLength(3);
    const finder = calls.find((c) => !systemOf(c).includes("refuter"))!;
    expect(finder.body.model).toBe(MODELS.opus);
    const prompt = promptOf(finder);
    expect(prompt).toContain("A web shop. Payments go through one gateway.");
    expect(prompt).toContain("=== spec/checkout.md"); // the spec the anchor ties to the changed file
    expect(prompt).toContain("+    let key = Uuid::new_v4().to_string();");

    const events = (await env.DB.prepare("SELECT event, data FROM job_events WHERE job_id = ?1 ORDER BY id").bind(jobId).all<{ event: string; data: string }>()).results;
    const stages = events.filter((e) => e.event === "progress").map((e) => (JSON.parse(e.data) as { stage: string }).stage);
    expect(stages).toEqual(["reading", "reviewing", "refuting", "refuting", "refuting", "done"]);
  });

  it("runs on the owner's subscription through Claude Code", async () => {
    const s = await seed();
    env.CLAUDE_CODE_OWNER = s.login;
    const { jobId } = await queued(s);
    await deliver(jobId);
    expect(calls.every((c) => c.origin === "http://claude-code.test")).toBe(true);
    const body = (await (await call(s)).json()) as ReviewBody;
    expect(body.review).toMatchObject({ state: "succeeded", backend: "claude-code" });
    expect(calls[0]!.body.maxTurns).toBe(1);
  });

  it("fails the review cleanly when no Claude is configured", async () => {
    const s = await seed();
    const { jobId } = await queued(s);
    await deliver(jobId);
    expect((await env.DB.prepare("SELECT state FROM jobs WHERE id = ?1").bind(jobId).first<{ state: string }>())!.state).toBe("failed");
    const body = (await (await call(s)).json()) as ReviewBody;
    expect(body.review).toMatchObject({ state: "failed", stage: "failed" });
    expect(body.review!.error).toMatch(/not configured/);
  });

  it("fails after its last attempt when the reviewer's answer is not JSON", async () => {
    const s = await seed();
    env.ANTHROPIC_API_KEY = "sk-ant-test";
    finderAnswer = "I could not review this.";
    const { jobId } = await queued(s, 1);
    await deliver(jobId);
    const body = (await (await call(s)).json()) as ReviewBody;
    expect(body.review).toMatchObject({ state: "failed", findings: [] });
    expect(body.review!.error).toMatch(/not the expected JSON/);
  });

  it("records the commit whose files it read when they lag the head", async () => {
    const s = await seed();
    env.ANTHROPIC_API_KEY = "sk-ant-test";
    await env.DB.prepare("UPDATE pull_requests SET files_sha = 'sha8' WHERE id = ?1").bind(s.pullId).run();
    const { jobId } = await queued(s);
    await deliver(jobId);
    const body = (await (await call(s)).json()) as ReviewBody & { review: { headSha: string } };
    expect(body.review).toMatchObject({ state: "succeeded", headSha: "sha8" });
  });
});

describe("agent review routes", () => {
  it("shows a review whose job died without a word as failed", async () => {
    const s = await seed();
    const { jobId } = await queued(s);
    await env.DB.prepare("UPDATE reviews SET state = 'running', stage = 'reviewing' WHERE job_id = ?1").bind(jobId).run();
    await env.DB.prepare("UPDATE jobs SET state = 'failed', error = 'dead-lettered' WHERE id = ?1").bind(jobId).run();
    const body = (await (await call(s)).json()) as ReviewBody;
    expect(body.review).toMatchObject({ state: "failed", stage: "failed", error: "the review stopped before it finished" });
  });

  it("answers null before any review, and 404 for a PR of another project", async () => {
    const s = await seed();
    expect(await (await call(s)).json()).toEqual({ review: null });
    const other = await seed();
    const res = await exports.default.fetch(new Request(`http://spectrace.test/api/projects/${s.projectId}/pulls/${other.pullId}/agent-review`, { headers: { cookie: s.cookie } }));
    expect(res.status).toBe(404);
    expect((await call(s, "GET", null)).status).toBe(401);
  });

  it("starts a review of the head commit, and hands back the same one while it runs", async () => {
    const s = await seed();
    const first = await call(s, "POST");
    expect(first.status).toBe(202);
    const a = (await first.json()) as ReviewBody & { review: { jobId: string; headSha: string } };
    expect(a.review).toMatchObject({ state: "queued", stage: "queued", headSha: "sha9", findings: [], dropped: 0 });
    const job = await env.DB.prepare("SELECT kind, target FROM jobs WHERE id = ?1").bind(a.review.jobId).first();
    expect(job).toEqual({ kind: REVIEW_KIND, target: a.review.id });

    const again = (await (await call(s, "POST")).json()) as ReviewBody;
    expect(again.review!.id).toBe(a.review.id);
  });
});

describe("parsing model answers", () => {
  it("finds the JSON object in prose and fences", () => {
    expect(parseJsonObject('Sure! {"a": 1} hope that helps')).toEqual({ a: 1 });
    expect(parseJsonObject('```json\n{"a": {"b": 2}}\n```')).toEqual({ a: { b: 2 } });
    expect(parseJsonObject("no json")).toBeNull();
    // A fenced snippet inside one of the answer's strings is not the answer.
    const inner = JSON.stringify({ walkthrough: 'Adds:\n```json\n{"retries": 3}\n```', findings: [] });
    expect(parseJsonObject(inner)).toEqual(JSON.parse(inner));
    expect(parseFinderAnswer('{"retries": 3}')).toBeNull();
  });

  it("cleans the walkthrough steps: unknown impact is medium, untitled steps go, long code is cut", () => {
    const code = Array.from({ length: 20 }, (_, i) => `+ line ${i}`).join("\n");
    const out = parseFinderAnswer(JSON.stringify({
      summary: "s", risk: "Critical", steps: [{ title: "A", path: "a.ts", impact: "whatever", code: "```ts\n" + code + "\n```" }, { impact: "high" }], decisions: ["q", 3, ""],
    }))!;
    expect(out.walk.risk).toBe("high");
    expect(out.walk.decisions).toEqual(["q"]);
    expect(out.walk.steps).toHaveLength(1);
    expect(out.walk.steps[0]).toMatchObject({ title: "A", paths: ["a.ts"], spec: null, impact: "medium", change: "", effect: "" });
    expect(out.walk.steps[0]!.code.split("\n")).toHaveLength(13);
    expect(out.walk.steps[0]!.code.startsWith("+ line 0")).toBe(true);
    // An older answer with only Markdown still reads, with no steps and no risk.
    expect(parseFinderAnswer(JSON.stringify({ walkthrough: "w", findings: [] }))!.walk).toMatchObject({ risk: null, steps: [], decisions: [], markdown: "w" });
  });

  it("cleans findings and refuses unreadable verdicts", () => {
    const out = parseFinderAnswer(JSON.stringify({ walkthrough: "w", findings: [{ severity: "CRITICAL", title: "t", line: "x" }, { severity: "high" }] }));
    expect(out).toMatchObject({ walkthrough: "w", findings: [{ severity: "high", path: "", line: null, title: "t", body: "", suggestedFix: "", spec: null }] });
    const sev = (severity: string) => parseFinderAnswer(JSON.stringify({ findings: [{ severity, title: "t" }] }))!.findings[0]!.severity;
    expect([sev("Blocker"), sev("minor"), sev("whatever")]).toEqual(["high", "low", "medium"]);
    expect(parseVerdict("maybe")).toEqual({ real: false, reason: "The refuter's answer could not be read." });
    expect(parseVerdict('{"real": "yes"}').real).toBe(false);
  });
});
