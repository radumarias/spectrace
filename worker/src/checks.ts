// CI check runs: the one place that writes `pr_check_runs`. The sync job and
// the `check_run` webhook both use it, and the PR detail route reads them.
import type { Bindings } from "./env";

/** The parts of GitHub's check run object that we store (REST and webhook payload alike). */
export interface GhCheckRun {
  id: number;
  head_sha: string;
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string | null;
  details_url?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

/**
 * Store one run. A run only moves forward (queued, in progress, completed),
 * so an event delivered late cannot undo a newer one. Its `meta.changes` says
 * whether anything changed.
 */
export function checkRunStatement(env: Bindings, repoId: string, run: GhCheckRun): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO pr_check_runs (repo_id, github_check_run_id, head_sha, name, status, conclusion, html_url, started_at, completed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT (repo_id, github_check_run_id) DO UPDATE SET
       head_sha = excluded.head_sha, name = excluded.name, status = excluded.status, conclusion = excluded.conclusion,
       html_url = excluded.html_url, started_at = excluded.started_at, completed_at = excluded.completed_at
     WHERE (CASE excluded.status WHEN 'completed' THEN 2 WHEN 'in_progress' THEN 1 ELSE 0 END)
           >= (CASE pr_check_runs.status WHEN 'completed' THEN 2 WHEN 'in_progress' THEN 1 ELSE 0 END)`,
  ).bind(repoId, run.id, run.head_sha, run.name, run.status, run.conclusion ?? null, run.html_url ?? run.details_url ?? "", run.started_at ?? null, run.completed_at ?? null);
}

export type ChecksState = "none" | "pending" | "passing" | "failing";

export interface CheckRunView {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  url: string;
  startedAt: string | null;
  completedAt: string | null;
}

/** Conclusions that do not hold a merge back. */
const OK = new Set(["success", "neutral", "skipped"]);

export function checksState(runs: CheckRunView[]): ChecksState {
  if (runs.length === 0) return "none";
  if (runs.some((r) => r.status === "completed" && !OK.has(r.conclusion ?? ""))) return "failing";
  if (runs.some((r) => r.status !== "completed")) return "pending";
  return "passing";
}

interface RunRow {
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  started_at: string | null;
  completed_at: string | null;
}

/** The runs of a commit as the page shows them: a re-run replaces its earlier run (same name, newest id wins), failures first. */
export async function checkRunsOf(env: Bindings, repoId: string, headSha: string): Promise<CheckRunView[]> {
  const { results } = await env.DB.prepare(
    `SELECT name, status, conclusion, html_url, started_at, completed_at FROM pr_check_runs c
      WHERE repo_id = ?1 AND head_sha = ?2
        AND github_check_run_id = (SELECT MAX(github_check_run_id) FROM pr_check_runs WHERE repo_id = c.repo_id AND head_sha = c.head_sha AND name = c.name)
      ORDER BY name`,
  )
    .bind(repoId, headSha)
    .all<RunRow>();
  const views = results.map((r): CheckRunView => ({
    name: r.name,
    status: r.status === "completed" ? "completed" : r.status === "in_progress" ? "in_progress" : "queued",
    conclusion: r.conclusion,
    url: r.html_url,
    startedAt: r.started_at,
    completedAt: r.completed_at,
  }));
  const weight = (v: CheckRunView) => (v.status === "completed" ? (OK.has(v.conclusion ?? "") ? 2 : 0) : 1);
  return views.sort((a, b) => weight(a) - weight(b));
}
