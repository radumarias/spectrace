// The "review" job (T3.4): an agent review of one pull request.
//
// 1. Read the PR, its diff, the project context and the specs the change
//    touches (spec files it edits, and specs whose anchors sit in files it edits).
// 2. Finder pass: one prompt that writes a walkthrough and lists candidate findings.
// 3. Refuter pass: each finding is handed to a fresh prompt that tries to
//    disprove it against the diff; only findings a refuter confirms are kept.
//
// Model calls go through `ask` (src/claude-code.ts): the owner's Claude
// subscription through Claude Code, else the requester's own API key, else
// the server's key through AI Gateway. `target` is the review id; the review
// row says who asked, which picks the backend.
import { MODELS } from "../ai";
import { ask } from "../claude-code";
import type { Bindings } from "../env";
import { AppError } from "../error";
import { NOW } from "../pulls";
import { errorMessage, isFinalFailure, PermanentError, registerHandler, type JobHandler } from "./queue";

export const REVIEW_KIND = "review";

/** Caps that keep one prompt well inside a model's context and the container's 1 MB body limit. */
const MAX_FILE_DIFF = 30_000;
const MAX_DIFF = 160_000;
const MAX_SPECS = 6;
const MAX_SPEC_CHARS = 16_000;
const MAX_CONTEXT = 8_000;
const MAX_FINDINGS = 20;
/** Refuters at once; the Claude Code container runs two prompts at a time. */
const REFUTERS_AT_ONCE = 2;
/** Progress this often while a model call runs, so the job keeps its 2-minute lease (queue.ts LEASE_SECONDS). */
const KEEPALIVE_MS = 60_000;

const FINDER_MODEL = MODELS.opus;
const REFUTER_MODEL = MODELS.sonnet;

export type Severity = "high" | "medium" | "low";

export interface Finding {
  severity: Severity;
  path: string;
  line: number | null;
  title: string;
  body: string;
  suggestedFix: string;
  spec: string | null;
}

export interface Verdict {
  real: boolean;
  reason: string;
}

type Progress = (data: Record<string, unknown>) => Promise<void>;

interface ReviewRow {
  id: string;
  pull_request_id: string;
  requested_by: string;
  head_sha: string;
}

interface PullInfo {
  id: string;
  repo_id: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  head_ref: string;
  base_ref: string;
  context: string;
  login: string;
  /** The commit whose changed files are stored in pr_files (null before they were first read). */
  files_sha: string | null;
}

interface FileDiff {
  path: string;
  status: string;
  patch: string | null;
}

interface SpecText {
  path: string;
  source: string;
}

/** The first JSON object in a model's answer, which may wrap it in prose or a code fence. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  // The whole answer first: a fence inside one of the object's strings (a code
  // snippet in the walkthrough) must not be taken for the answer.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates = [text, fenced?.[1]];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf("{");
    const end = c.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    try {
      const v: unknown = JSON.parse(c.slice(start, end + 1));
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** The model's severity word as ours: stronger words count as high, and a word we don't know as medium, never quietly as low. */
function severityOf(word: string): Severity {
  if (["high", "critical", "blocker", "major", "severe"].includes(word)) return "high";
  if (["low", "minor", "nit", "info", "trivial"].includes(word)) return "low";
  return "medium";
}

/** The finder's answer, cleaned: unknown severities become "medium", findings without a title are dropped. */
export function parseFinderAnswer(text: string): { walkthrough: string; findings: Finding[] } | null {
  const obj = parseJsonObject(text);
  if (!obj || (typeof obj.walkthrough !== "string" && !Array.isArray(obj.findings))) return null;
  const walkthrough = str(obj.walkthrough, 20_000);
  const raw = Array.isArray(obj.findings) ? obj.findings : [];
  const findings: Finding[] = [];
  for (const f of raw.slice(0, MAX_FINDINGS)) {
    if (!f || typeof f !== "object") continue;
    const o = f as Record<string, unknown>;
    const title = str(o.title, 300);
    if (!title) continue;
    const sev = str(o.severity, 10).toLowerCase();
    const line = typeof o.line === "number" && Number.isInteger(o.line) && o.line > 0 ? o.line : null;
    findings.push({
      severity: severityOf(sev),
      path: str(o.path, 500),
      line,
      title,
      body: str(o.body, 4_000),
      suggestedFix: str(o.suggested_fix ?? o.suggestedFix, 4_000),
      spec: str(o.spec, 500) || null,
    });
  }
  return { walkthrough, findings };
}

/** A refuter's answer. Anything that is not a clear "real" counts as not confirmed. */
export function parseVerdict(text: string): Verdict {
  const obj = parseJsonObject(text);
  if (!obj) return { real: false, reason: "The refuter's answer could not be read." };
  return { real: obj.real === true, reason: str(obj.reason, 1_000) };
}

const FINDER_SYSTEM = `You are the reviewer of spectrace, a spec-driven code review tool. You review one pull request: its diff, the specs it touches (Markdown flow specs: steps, requirements, diagrams), and the project's context.

Find real problems a careful senior engineer would block or flag: bugs, broken or unmet spec requirements, security issues, data loss, races, missing error handling, missing tests for changed behaviour. Do not report style, naming or formatting, and do not report something you cannot point to in the diff. Prefer few, sure findings over many guesses.

Severity: "high" means wrong behaviour, data loss or a security hole; "medium" means a likely bug or an unmet requirement; "low" means a smaller risk worth fixing.

Do not use any tools. Answer with one JSON object and nothing else:
{"walkthrough": "<Markdown: what the PR does, file by file in a short list, and how it relates to the specs>",
 "findings": [{"severity": "high|medium|low", "path": "<file path from the diff>", "line": <line number in the new file, or null>, "title": "<one line>", "body": "<why it is a problem, citing the code>", "suggested_fix": "<what to change>", "spec": "<spec path it breaks, or null>"}]}
Use an empty findings list when the change is fine.`;

const REFUTER_SYSTEM = `You are a refuter for spectrace's code review. Another reviewer reported a finding on a pull request. Your job is to try to disprove it: read the diff and the specs and decide whether the finding is real. A finding is real only if the code in the diff actually has the problem as described. It is not real if it misreads the code, is already handled elsewhere in the diff, is about code the PR did not change, or is only a matter of style.

Do not use any tools. Answer with one JSON object and nothing else: {"real": true or false, "reason": "<one or two sentences>"}`;

function diffText(files: FileDiff[]): string {
  let total = 0;
  const parts: string[] = [];
  const left: string[] = [];
  for (const f of files) {
    if (!f.patch) {
      parts.push(`--- ${f.path} (${f.status}; no text diff: binary or too large)`);
      continue;
    }
    const patch = f.patch.length > MAX_FILE_DIFF ? `${f.patch.slice(0, MAX_FILE_DIFF)}\n… (diff cut)` : f.patch;
    if (total + patch.length > MAX_DIFF) {
      left.push(f.path);
      continue;
    }
    total += patch.length;
    parts.push(`--- ${f.path} (${f.status})\n${patch}`);
  }
  if (left.length) parts.push(`(Diffs left out for size: ${left.join(", ")})`);
  return parts.join("\n\n");
}

function specsText(specs: SpecText[]): string {
  if (specs.length === 0) return "No spec covers the changed files.";
  return specs.map((s) => `=== ${s.path}\n${s.source.length > MAX_SPEC_CHARS ? `${s.source.slice(0, MAX_SPEC_CHARS)}\n… (cut)` : s.source}`).join("\n\n");
}

export function finderPrompt(pr: Pick<PullInfo, "repo" | "number" | "title" | "body" | "head_ref" | "base_ref" | "context">, files: FileDiff[], specs: SpecText[]): string {
  return [
    `Pull request ${pr.repo}#${pr.number}: ${pr.title}`,
    `Branch ${pr.head_ref} into ${pr.base_ref}.`,
    `\n## Project context\n${pr.context.trim().slice(0, MAX_CONTEXT) || "None given."}`,
    `\n## Description\n${pr.body.trim().slice(0, 8_000) || "None given."}`,
    `\n## Specs the change touches\n${specsText(specs)}`,
    `\n## Diff\n${diffText(files)}`,
    "\nReview it and answer with the JSON object.",
  ].join("\n");
}

export function refuterPrompt(pr: Pick<PullInfo, "repo" | "number" | "title">, finding: Finding, files: FileDiff[], specs: SpecText[]): string {
  const own = files.filter((f) => f.path === finding.path);
  const named = specs.filter((s) => s.path === finding.spec);
  return [
    `Pull request ${pr.repo}#${pr.number}: ${pr.title}`,
    `\n## The finding\n${JSON.stringify({ severity: finding.severity, path: finding.path, line: finding.line, title: finding.title, body: finding.body, spec: finding.spec })}`,
    `\n## Specs\n${specsText(named.length ? named : specs)}`,
    `\n## Diff${own.length ? ` of ${finding.path}` : ""}\n${diffText(own.length ? own : files)}`,
    "\nIs the finding real? Answer with the JSON object.",
  ].join("\n");
}

/** Show the review's stage on its row and tell the browsers (progress also keeps the job's lease). */
async function setStage(env: Bindings, reviewId: string, stage: string, progress: Progress, extra: Record<string, unknown> = {}) {
  await env.DB.prepare("UPDATE reviews SET stage = ?2, state = 'running' WHERE id = ?1").bind(reviewId, stage).run();
  await progress({ review: reviewId, stage, ...extra });
}

/** Runs `work`, reporting `data()` every minute until it ends: a long model call must not look like a dead worker. */
async function keepingAlive<T>(progress: Progress, data: () => Record<string, unknown>, work: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => void progress(data()).catch(() => undefined), KEEPALIVE_MS);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

async function loadPull(env: Bindings, review: ReviewRow): Promise<PullInfo> {
  const pr = await env.DB.prepare(
    `SELECT p.id, p.repo_id, r.full_name AS repo, p.number, p.title, p.body, p.head_ref, p.base_ref, p.files_sha, pj.context, u.login
       FROM pull_requests p JOIN project_repos r ON r.id = p.repo_id JOIN projects pj ON pj.id = r.project_id, users u
      WHERE p.id = ?1 AND u.id = ?2`,
  )
    .bind(review.pull_request_id, review.requested_by)
    .first<PullInfo>();
  if (!pr) throw new PermanentError("the pull request or the person who asked for the review is gone");
  return pr;
}

async function touchedSpecs(env: Bindings, repoId: string, paths: string[]): Promise<SpecText[]> {
  if (paths.length === 0) return [];
  const json = JSON.stringify(paths);
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT s.path, s.source FROM specs s
      WHERE s.repo_id = ?1 AND (s.path IN (SELECT value FROM json_each(?2))
         OR s.id IN (SELECT a.spec_id FROM anchors a WHERE a.repo_id = ?1 AND a.spec_id IS NOT NULL AND a.path IN (SELECT value FROM json_each(?2))))
      ORDER BY s.path LIMIT ?3`,
  )
    .bind(repoId, json, MAX_SPECS)
    .all<SpecText>();
  return results;
}

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

const reviewHandler: JobHandler = async (job, { env, progress }) => {
  const review = await env.DB.prepare("SELECT id, pull_request_id, requested_by, head_sha FROM reviews WHERE id = ?1").bind(job.target).first<ReviewRow>();
  if (!review) throw new PermanentError(`review ${job.target} not found`);
  try {
    await runReview(env, review, progress);
  } catch (error) {
    // Show the failure on the review once the queue gives up on the job.
    if (isFinalFailure(job, error)) {
      await env.DB.prepare(`UPDATE reviews SET state = 'failed', stage = 'failed', error = ?2, finished_at = ${NOW} WHERE id = ?1`)
        .bind(review.id, errorMessage(error).slice(0, 500))
        .run();
    }
    throw error;
  }
};

async function runReview(env: Bindings, review: ReviewRow, progress: Progress) {
  await setStage(env, review.id, "reading", progress);
  const pr = await loadPull(env, review);
  const { results: files } = await env.DB.prepare("SELECT path, status, patch FROM pr_files WHERE pull_request_id = ?1 ORDER BY path").bind(pr.id).all<FileDiff>();
  if (files.length === 0) throw new PermanentError("no changed files are stored for this pull request; pull from GitHub first");
  const specs = await touchedSpecs(env, pr.repo_id, files.map((f) => f.path));
  const user = { id: review.requested_by, login: pr.login };

  await setStage(env, review.id, "reviewing", progress, { specs: specs.length, files: files.length });
  const found = await keepingAlive(
    progress,
    () => ({ review: review.id, stage: "reviewing" }),
    () => ask(env, user, { model: FINDER_MODEL, system: FINDER_SYSTEM, prompt: finderPrompt(pr, files, specs), maxTokens: 16_000, timeoutMs: 9 * 60_000 }),
  );
  const answer = parseFinderAnswer(found.text);
  if (!answer) throw new AppError("upstream", "the reviewer's answer was not the expected JSON");

  await setStage(env, review.id, "refuting", progress, { findings: answer.findings.length });
  let checked = 0;
  const refuting = () => ({ review: review.id, stage: "refuting", findings: answer.findings.length, checked });
  const verdicts = await keepingAlive(progress, refuting, () =>
    inBatches(answer.findings, REFUTERS_AT_ONCE, async (f) => {
      const out = await ask(env, user, { model: REFUTER_MODEL, system: REFUTER_SYSTEM, prompt: refuterPrompt(pr, f, files, specs), maxTokens: 2_000, timeoutMs: 5 * 60_000 });
      checked++;
      await progress(refuting());
      return parseVerdict(out.text);
    }),
  );

  // The review is of the commit whose files were read, which lags the head until a sync reads the new ones.
  const reviewed = pr.files_sha ?? review.head_sha;

  // Replace whatever an earlier attempt of this job stored, all in one transaction.
  const statements = [env.DB.prepare("DELETE FROM findings WHERE review_id = ?1").bind(review.id)];
  answer.findings.forEach((f, i) => {
    const v = verdicts[i]!;
    statements.push(
      env.DB.prepare(
        `INSERT INTO findings (review_id, severity, path, line, title, body, suggested_fix, spec, refuted, refuter_note)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      ).bind(review.id, f.severity, f.path, f.line, f.title, f.body, f.suggestedFix, f.spec, v.real ? 0 : 1, v.reason),
    );
  });
  statements.push(
    env.DB.prepare(
      `UPDATE reviews SET state = 'succeeded', stage = 'done', walkthrough = ?2, backend = ?3, model = ?4, head_sha = ?5, error = NULL,
         finished_at = ${NOW} WHERE id = ?1`,
    ).bind(review.id, answer.walkthrough, found.backend, found.model, reviewed),
  );
  await env.DB.batch(statements);
  const kept = verdicts.filter((v) => v.real).length;
  await progress({ review: review.id, stage: "done", findings: kept, dropped: verdicts.length - kept });
}

registerHandler(REVIEW_KIND, reviewHandler);
