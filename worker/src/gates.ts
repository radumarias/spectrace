// Merge gates of a pull request: the facts come from D1, the rules from
// `crates/core` (gate.rs, through the WASM build).
import { checkRunsOf } from "./checks";
import type { Gate, GateInput } from "./core";
import type { Bindings } from "./env";

export type { Gate };

interface PullFacts {
  id: string;
  repo_id: string;
  head_sha: string;
}

/**
 * The gate input of a pull request's head commit.
 *
 * Approvals are the people whose latest review of this commit approves it:
 * reviews synced from GitHub (by login, the App's own `[bot]` review left from
 * spectrace excluded so it is not counted twice) plus the ones left from
 * spectrace (by user). A push starts approvals again, because they are tied to
 * the head commit.
 */
export async function gateInput(env: Bindings, pr: PullFacts): Promise<GateInput> {
  const review = await env.DB.prepare("SELECT id FROM reviews WHERE pull_request_id = ?1 AND head_sha = ?2 AND state = 'succeeded' ORDER BY created_at DESC LIMIT 1")
    .bind(pr.id, pr.head_sha)
    .first<{ id: string }>();
  const serious = review
    ? ((await env.DB.prepare("SELECT COUNT(*) AS n FROM findings WHERE review_id = ?1 AND refuted = 0 AND severity IN ('high', 'medium')").bind(review.id).first<{ n: number }>())?.n ?? 0)
    : 0;

  const checks = await checkRunsOf(env, pr.repo_id, pr.head_sha);
  const ok = new Set(["success", "neutral", "skipped"]);
  const failed = checks.filter((c) => c.status === "completed" && !ok.has(c.conclusion ?? "")).length;
  const pending = checks.filter((c) => c.status !== "completed").length;

  const github = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM pr_reviews r
      WHERE r.pull_request_id = ?1 AND r.commit_sha = ?2 AND r.state = 'approved' AND r.reviewer_login NOT LIKE '%[bot]'
        AND r.github_review_id = (SELECT MAX(x.github_review_id) FROM pr_reviews x
                                   WHERE x.pull_request_id = r.pull_request_id AND x.reviewer_login = r.reviewer_login AND x.state IN ('approved', 'changes_requested', 'dismissed'))`,
  )
    .bind(pr.id, pr.head_sha)
    .first<{ n: number }>();
  const local = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM pull_reviews v
      WHERE v.pull_request_id = ?1 AND v.head_sha = ?2 AND v.verdict = 'approved'
        AND v.id = (SELECT MAX(x.id) FROM pull_reviews x WHERE x.pull_request_id = v.pull_request_id AND x.user_id = v.user_id)`,
  )
    .bind(pr.id, pr.head_sha)
    .first<{ n: number }>();

  return {
    reviewFinished: review !== null,
    openSeriousFindings: serious,
    checksTotal: checks.length,
    checksFailed: failed,
    checksPending: pending,
    approvals: (github?.n ?? 0) + (local?.n ?? 0),
    critical: false, // no per-repo "critical" setting yet
    filesMapped: null, // T4.6
  };
}

export async function pullGates(env: Bindings, pr: PullFacts): Promise<Gate[]> {
  // Loaded when first needed: `just api-client` builds the app under Node, which cannot load the .wasm import.
  const { evaluateGates } = await import("./core");
  return evaluateGates(await gateInput(env, pr));
}
