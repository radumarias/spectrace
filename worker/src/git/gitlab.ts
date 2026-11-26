// GitLab as a git provider (REST API v4, self-hosted or gitlab.com). It acts
// as the project owner's connected GitLab account. Merge requests are stored
// as pull requests: `number` is the MR's iid, `id` its global id, and the
// jobs of the newest pipeline on a commit are its check runs.
import type { GhCheckRun } from "../checks";
import type { Bindings } from "../env";
import { AppError } from "../error";
import { gitlabConfigOrNull, gitlabToken, glHeaders, type GitlabConfig } from "../gitlab";
import { PermanentError } from "../jobs/queue";
import type { GhFile, GhPull } from "../pulls";
import type { Answer, MergeMethod, RepoClient, RepoInfo, TreeInfo, Verdict } from "./types";

const PAGE_SIZE = 100;
/** Same cap as GitHub's 3000 files. */
const MAX_FILE_PAGES = 30;
/** Counting files stops here (10 000 files) and the tree is marked truncated. */
const MAX_TREE_PAGES = 100;

/** A merge request as the API (and so the sync) sees it. */
export interface GlMergeRequest {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: string; // opened, closed, locked, merged
  draft?: boolean;
  work_in_progress?: boolean;
  web_url: string;
  author: { username: string } | null;
  source_branch: string;
  target_branch: string;
  sha: string;
  created_at: string;
  updated_at: string;
  merged_at?: string | null;
}

interface GlDiff {
  old_path: string;
  new_path: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  diff: string;
  too_large?: boolean;
}

interface GlJob {
  id: number;
  name: string;
  status: string;
  allow_failure?: boolean;
  web_url?: string;
  started_at?: string | null;
  finished_at?: string | null;
}

/** A merge request in the shape spectrace stores pull requests in. */
export function toPull(mr: GlMergeRequest): GhPull {
  const merged = mr.state === "merged";
  return {
    id: mr.id,
    number: mr.iid,
    title: mr.title,
    body: mr.description,
    state: mr.state === "opened" ? "open" : "closed",
    draft: mr.draft ?? mr.work_in_progress ?? false,
    html_url: mr.web_url,
    user: mr.author ? { login: mr.author.username } : null,
    head: { ref: mr.source_branch, sha: mr.sha },
    base: { ref: mr.target_branch },
    created_at: mr.created_at,
    updated_at: mr.updated_at,
    merged_at: merged ? (mr.merged_at ?? mr.updated_at) : null,
  };
}

/** One changed file. GitLab's diff has no file headers, so every `+` and `-` line is a change. */
export function toFile(d: GlDiff): GhFile {
  let additions = 0;
  let deletions = 0;
  for (const line of d.diff.split("\n")) {
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  const status = d.new_file ? "added" : d.deleted_file ? "removed" : d.renamed_file ? "renamed" : "modified";
  return {
    filename: d.new_path,
    status,
    ...(d.renamed_file ? { previous_filename: d.old_path } : {}),
    additions,
    deletions,
    ...(d.diff && !d.too_large ? { patch: d.diff } : {}),
  };
}

/** A pipeline job as a check run: GitLab's statuses folded into queued, in progress and completed. */
export function toCheckRun(job: GlJob, sha: string): GhCheckRun {
  const done: Record<string, string> = { success: "success", failed: "failure", canceled: "cancelled", skipped: "skipped", manual: "action_required" };
  const conclusion = job.status === "failed" && job.allow_failure ? "neutral" : (done[job.status] ?? null);
  return {
    id: job.id,
    head_sha: sha,
    name: job.name,
    status: conclusion ? "completed" : job.status === "running" ? "in_progress" : "queued",
    conclusion,
    html_url: job.web_url ?? "",
    started_at: job.started_at ?? null,
    completed_at: conclusion ? (job.finished_at ?? null) : null,
  };
}

type Raw = { status: number; json: Record<string, unknown> & { message?: unknown; error?: unknown } };

/** GitLab's `message` is a string, a list, or an object of lists. */
function messageOf(json: Raw["json"], status: number): string {
  const m = json.message ?? json.error;
  if (typeof m === "string") return m;
  if (Array.isArray(m)) return m.join("; ");
  if (m && typeof m === "object") return Object.entries(m as Record<string, unknown>).map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(", ") : String(v)}`).join("; ");
  return `GitLab answered ${status}`;
}
const refuse = (what: string, res: Raw) => new AppError("conflict", `conflict: ${what}: ${messageOf(res.json, res.status)}`);

/** For jobs: 4xx other than rate limits cannot be fixed by trying again. */
function failure(what: string, status: number): Error {
  const msg = `GitLab ${what}: status ${status}`;
  return status >= 400 && status < 500 && status !== 429 ? new PermanentError(msg) : new Error(msg);
}

const b64ToText = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

export class GitlabProject implements RepoClient {
  readonly provider = "gitlab" as const;

  constructor(
    private readonly cfg: GitlabConfig,
    private readonly token: string,
    readonly fullName: string,
  ) {}

  /** `/projects/<url-encoded path>`. */
  private get base() {
    return `${this.cfg.apiUrl}/projects/${encodeURIComponent(this.fullName)}`;
  }

  private async send(method: string, path: string, body?: unknown): Promise<Response> {
    try {
      return await fetch(`${this.base}${path}`, {
        method,
        headers: { ...glHeaders(this.token), ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      throw new AppError("upstream", `GitLab ${method} ${path}: ${String(cause)}`, { cause });
    }
  }

  /** A call whose answer the caller reads. 5xx and rate limits throw. */
  private async call(method: string, path: string, body?: unknown): Promise<Raw> {
    const res = await this.send(method, path, body);
    const json = (await res.json().catch(() => ({}))) as Raw["json"];
    if (res.status >= 500 || res.status === 429) throw new AppError("upstream", `GitLab ${method} ${path}: status ${res.status} ${messageOf(json, res.status)}`);
    return { status: res.status, json };
  }

  /** A read for the jobs. */
  private async read<T>(what: string, path: string): Promise<T> {
    const res = await this.send("GET", path);
    if (!res.ok) throw failure(what, res.status);
    return (await res.json()) as T;
  }

  private async pages<T>(what: string, path: string, maxPages: number): Promise<{ items: T[]; more: boolean }> {
    const items: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const batch = await this.read<T[]>(what, `${path}${sep}per_page=${PAGE_SIZE}&page=${page}`);
      items.push(...batch);
      if (batch.length < PAGE_SIZE) return { items, more: false };
    }
    return { items, more: true };
  }

  async openPulls(): Promise<GhPull[]> {
    const { items } = await this.pages<GlMergeRequest>(`merge requests of ${this.fullName}`, "/merge_requests?state=opened&order_by=created_at&sort=asc", Infinity);
    return items.map(toPull);
  }

  async recentlyClosedPulls(): Promise<GhPull[]> {
    const merged = await this.read<GlMergeRequest[]>(`merged merge requests of ${this.fullName}`, `/merge_requests?state=merged&order_by=updated_at&sort=desc&per_page=${PAGE_SIZE}`);
    const closed = await this.read<GlMergeRequest[]>(`closed merge requests of ${this.fullName}`, `/merge_requests?state=closed&order_by=updated_at&sort=desc&per_page=${PAGE_SIZE}`);
    return [...merged, ...closed].map(toPull);
  }

  async pull(number: number): Promise<GhPull | null> {
    const res = await this.send("GET", `/merge_requests/${number}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new AppError("upstream", `GitLab ${this.fullName}!${number}: status ${res.status}`);
    return toPull((await res.json()) as GlMergeRequest);
  }

  async pullFiles(number: number): Promise<GhFile[]> {
    const probe = await this.send("GET", `/merge_requests/${number}/diffs?per_page=1&page=1`);
    if (probe.status === 404 && (await this.pull(number))) {
      // GitLab before 15.7 has no `/diffs`: the older `/changes` lists them all at once.
      const all = await this.read<{ changes: GlDiff[] }>(`changes of ${this.fullName}!${number}`, `/merge_requests/${number}/changes?access_raw_diffs=true`);
      return all.changes.map(toFile);
    }
    const { items } = await this.pages<GlDiff>(`diffs of ${this.fullName}!${number}`, `/merge_requests/${number}/diffs`, MAX_FILE_PAGES);
    return items.map(toFile);
  }

  async checkRuns(sha: string): Promise<GhCheckRun[] | null> {
    const res = await this.send("GET", `/pipelines?sha=${encodeURIComponent(sha)}&order_by=id&sort=desc&per_page=1`);
    if (!res.ok) return null;
    const [pipeline] = (await res.json()) as { id: number }[];
    if (!pipeline) return [];
    const jobs = await this.send("GET", `/pipelines/${pipeline.id}/jobs?per_page=${PAGE_SIZE}`);
    if (!jobs.ok) return null;
    return ((await jobs.json()) as GlJob[]).map((j) => toCheckRun(j, sha));
  }

  async review(number: number, headSha: string, verdict: Verdict, body: string): Promise<Answer<{ id: number | null }>> {
    if (verdict === "approve") {
      const res = await this.call("POST", `/merge_requests/${number}/approve`, { sha: headSha });
      // 401: may not approve (own MR, rules); 409: the head moved.
      if (res.status !== 201 && res.status !== 200) return { ok: false, notFound: res.status === 404, message: messageOf(res.json, res.status) };
      if (body) await this.call("POST", `/merge_requests/${number}/notes`, { body });
      return { ok: true, id: null };
    }
    // GitLab has no "request changes" review in REST: take back an approval and say why in a comment.
    await this.call("POST", `/merge_requests/${number}/unapprove`);
    const note = await this.call("POST", `/merge_requests/${number}/notes`, { body: `**Changes requested**\n\n${body}` });
    if (note.status !== 201) return { ok: false, notFound: note.status === 404, message: messageOf(note.json, note.status) };
    return { ok: true, id: typeof note.json.id === "number" ? note.json.id : null };
  }

  async merge(number: number, headSha: string, method: MergeMethod): Promise<Answer<object>> {
    if (method === "rebase") return { ok: false, notFound: false, message: "GitLab merges here with a merge commit or squash; rebase the branch on GitLab first" };
    const res = await this.call("PUT", `/merge_requests/${number}/merge`, { sha: headSha, squash: method === "squash" });
    // 405: not mergeable (draft, pipeline, approvals, closed); 406: conflicts; 409: head moved; 422: failed.
    if (res.status !== 200) return { ok: false, notFound: res.status === 404, message: messageOf(res.json, res.status) };
    return { ok: true };
  }

  async repository(): Promise<RepoInfo> {
    const info = await this.read<{ id: number; default_branch?: string | null }>("project", "");
    return { id: info.id, defaultBranch: info.default_branch ?? "main" };
  }

  async tree(branch: string): Promise<TreeInfo | null> {
    const head = await this.send("GET", `/repository/branches/${encodeURIComponent(branch)}`);
    // No branch: an empty project.
    if (head.status === 404) return null;
    if (!head.ok) throw failure("branch", head.status);
    const sha = ((await head.json()) as { commit: { id: string } }).commit.id;
    const { items, more } = await this.pages<{ type: string }>("repository tree", `/repository/tree?ref=${encodeURIComponent(sha)}&recursive=true`, MAX_TREE_PAGES);
    return { sha, fileCount: items.filter((e) => e.type === "blob").length, truncated: more };
  }

  async archive(branch: string): Promise<ReadableStream<Uint8Array>> {
    const res = await this.send("GET", `/repository/archive.tar.gz?sha=${encodeURIComponent(branch)}`);
    if (!res.ok || !res.body) throw failure("archive", res.status);
    return res.body;
  }

  languages(): Promise<Record<string, number>> {
    return this.read<Record<string, number>>("languages", "/languages");
  }

  async readFile(path: string, ref: string): Promise<{ text: string; sha: string } | null> {
    const res = await this.call("GET", `/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`);
    if (res.status === 404) return null;
    if (res.status !== 200 || typeof res.json.content !== "string" || typeof res.json.blob_id !== "string") throw refuse(`reading ${path}`, res);
    return { text: b64ToText(res.json.content), sha: res.json.blob_id };
  }

  async branchHead(branch: string): Promise<string> {
    const res = await this.call("GET", `/repository/branches/${encodeURIComponent(branch)}`);
    const sha = (res.json.commit as { id?: unknown } | undefined)?.id;
    if (res.status !== 200 || typeof sha !== "string") throw refuse(`reading ${branch}`, res);
    return sha;
  }

  async createBranch(name: string, sha: string): Promise<void> {
    const res = await this.call("POST", `/repository/branches?branch=${encodeURIComponent(name)}&ref=${encodeURIComponent(sha)}`);
    if (res.status !== 201) throw refuse(`creating ${name}`, res);
  }

  async putFile(o: { path: string; branch: string; message: string; text: string; sha: string | null }): Promise<void> {
    const res = await this.call(o.sha ? "PUT" : "POST", `/repository/files/${encodeURIComponent(o.path)}`, {
      branch: o.branch,
      content: o.text,
      encoding: "text",
      commit_message: o.message,
    });
    if (res.status !== 200 && res.status !== 201) throw refuse(`committing ${o.path}`, res);
  }

  async openPull(o: { title: string; head: string; base: string; body: string }): Promise<{ number: number; url: string }> {
    const res = await this.call("POST", "/merge_requests", { source_branch: o.head, target_branch: o.base, title: o.title, description: o.body, remove_source_branch: true });
    if (res.status !== 201 || typeof res.json.iid !== "number" || typeof res.json.web_url !== "string") throw refuse("opening the merge request", res);
    return { number: res.json.iid, url: res.json.web_url };
  }

  /** Who approved the merge request now; null when GitLab would not say (approvals are a paid feature on some instances). */
  async approvers(number: number): Promise<{ id: number; username: string }[] | null> {
    try {
      const res = await this.send("GET", `/merge_requests/${number}/approvals`);
      if (!res.ok) return null;
      const body = (await res.json()) as { approved_by?: { user: { id: number; username: string } }[] };
      return (body.approved_by ?? []).map((a) => ({ id: a.user.id, username: a.user.username }));
    } catch {
      return null;
    }
  }

  /**
   * Make sure the project sends its merge request, push and pipeline events to
   * spectrace. Needs Maintainer; returns what happened, never throws.
   */
  async ensureHook(url: string, secret: string): Promise<"exists" | "created" | "failed"> {
    try {
      const hooks = await this.send("GET", `/hooks?per_page=${PAGE_SIZE}`);
      if (!hooks.ok) return "failed";
      if (((await hooks.json()) as { url: string }[]).some((h) => h.url === url)) return "exists";
      const res = await this.send("POST", "/hooks", {
        url,
        token: secret,
        push_events: true,
        merge_requests_events: true,
        pipeline_events: true,
        job_events: true,
        enable_ssl_verification: true,
      });
      return res.status === 201 ? "created" : "failed";
    } catch {
      return "failed";
    }
  }
}

/**
 * A client acting as the project owner's GitLab account. Missing setup fails
 * the job for good, or answers 409 to a request.
 */
export async function gitlabFor(env: Bindings, projectId: string, fullName: string, purpose: "sync" | "index" | "write"): Promise<GitlabProject> {
  const fail = (msg: string) => (purpose === "write" ? new AppError("conflict", `conflict: ${msg}`) : new PermanentError(msg));
  const cfg = gitlabConfigOrNull(env);
  if (!cfg) throw fail("GitLab is not configured on this server (GITLAB_URL)");
  const owner = await env.DB.prepare("SELECT owner_id FROM projects WHERE id = ?1").bind(projectId).first<{ owner_id: string }>();
  if (!owner) throw fail(`project ${projectId} is gone`);
  const token = await gitlabToken(env, cfg, owner.owner_id);
  if (!token) throw fail(`no GitLab account connected for ${fullName}; connect GitLab in the project settings first`);
  return new GitlabProject(cfg, token, fullName);
}

/**
 * Store a merge request's GitLab approvals as approving reviews of its head
 * commit (GitLab drops approvals on push when the project says so, and the next
 * read says who still approves). `github_review_id` holds the approver's GitLab user id.
 */
export async function storeApprovals(env: Bindings, client: GitlabProject, pullId: string, number: number, headSha: string, updatedAt: string): Promise<void> {
  const approvers = await client.approvers(number);
  if (approvers === null) return;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pr_reviews WHERE pull_request_id = ?1").bind(pullId),
    ...approvers.map((a) =>
      env.DB.prepare(
        "INSERT OR REPLACE INTO pr_reviews (pull_request_id, github_review_id, reviewer_login, state, body, commit_sha, submitted_at) VALUES (?1, ?2, ?3, 'approved', '', ?4, ?5)",
      ).bind(pullId, a.id, a.username, headSha, updatedAt),
    ),
  ]);
}
