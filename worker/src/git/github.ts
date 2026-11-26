// GitHub as a git provider: the spectrace GitHub App, installed on the repo's
// owner, reads and writes as itself with a short-lived installation token.
import type { GhCheckRun } from "../checks";
import type { Bindings } from "../env";
import { AppError } from "../error";
import { appConfigFromEnv, appJwt, ghHeaders, installationToken, linkRepoInstallation, type AppConfig } from "../github-app";
import { PermanentError } from "../jobs/queue";
import type { GhFile, GhPull } from "../pulls";
import type { Answer, MergeMethod, RepoClient, RepoInfo, TreeInfo, Verdict } from "./types";

const PAGE_SIZE = 100;
/** GitHub stops listing a PR's files after 3000. */
export const MAX_FILE_PAGES = 30;
/** How many pages (of 100) of recently closed PRs a sync reads. */
const RECENT_CLOSED_PAGES = 1;
const MAX_CHECK_PAGES = 5;

export async function ghPages<T>(app: AppConfig, token: string, what: string, path: string, maxPages = Infinity): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = path.includes("?") ? "&" : "?";
    let res: Response;
    try {
      res = await fetch(`${app.apiUrl}${path}${sep}per_page=${PAGE_SIZE}&page=${page}`, { headers: ghHeaders(token) });
    } catch (cause) {
      throw new AppError("upstream", `GitHub ${what}: ${String(cause)}`, { cause });
    }
    if (res.status === 404) throw new PermanentError(`GitHub ${what}: not found (is the app installed on this repository?)`);
    if (!res.ok) throw new AppError("upstream", `GitHub ${what}: status ${res.status}`);
    const batch = (await res.json()) as T[];
    out.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return out;
}

/** 4xx other than rate limits cannot be fixed by trying again; 5xx and rate limits can. */
function failure(what: string, res: Response): Error {
  const rateLimited = res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
  const msg = `GitHub ${what}: status ${res.status}`;
  return res.status >= 400 && res.status < 500 && !rateLimited ? new PermanentError(msg) : new Error(msg);
}

type Raw = { status: number; json: Record<string, unknown> };

const message = (json: Record<string, unknown>) => (typeof json.message === "string" ? json.message : "GitHub refused");
const refuse = (what: string, res: Raw) => new AppError("conflict", `conflict: ${what}: ${typeof res.json.message === "string" ? res.json.message : `GitHub answered ${res.status}`}`);
const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/** UTF-8 text as base64, for the contents API. */
function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const unbase64 = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

export class GithubRepo implements RepoClient {
  readonly provider = "github" as const;

  constructor(
    private readonly app: AppConfig,
    private readonly token: string,
    readonly fullName: string,
  ) {}

  private get repo() {
    return `/repos/${this.fullName}`;
  }

  /** A call whose answer the caller reads. 5xx, auth and rate-limit answers and network errors throw. */
  private async call(method: string, path: string, body?: unknown): Promise<Raw> {
    let res: Response;
    try {
      res = await fetch(`${this.app.apiUrl}${path}`, { method, headers: { ...ghHeaders(this.token), "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch (cause) {
      throw new AppError("upstream", `GitHub ${method} ${path}: ${String(cause)}`, { cause });
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status >= 500 || res.status === 401 || res.status === 403 || res.status === 429) {
      throw new AppError("upstream", `GitHub ${method} ${path}: status ${res.status} ${String(json.message ?? "")}`);
    }
    return { status: res.status, json };
  }

  /** A read for the index job: errors are permanent or not as `failure` says. */
  private async get(path: string): Promise<Response> {
    try {
      return await fetch(`${this.app.apiUrl}${path}`, { headers: ghHeaders(this.token) });
    } catch (cause) {
      throw new Error(`GitHub ${path}: ${String(cause)}`, { cause });
    }
  }

  openPulls(): Promise<GhPull[]> {
    return ghPages<GhPull>(this.app, this.token, `pulls of ${this.fullName}`, `${this.repo}/pulls?state=open&sort=created&direction=asc`);
  }

  recentlyClosedPulls(): Promise<GhPull[]> {
    return ghPages<GhPull>(this.app, this.token, `closed pulls of ${this.fullName}`, `${this.repo}/pulls?state=closed&sort=updated&direction=desc`, RECENT_CLOSED_PAGES);
  }

  async pull(number: number): Promise<GhPull | null> {
    let res: Response;
    try {
      res = await fetch(`${this.app.apiUrl}${this.repo}/pulls/${number}`, { headers: ghHeaders(this.token) });
    } catch (cause) {
      throw new AppError("upstream", `GitHub ${this.fullName}#${number}: ${String(cause)}`, { cause });
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new AppError("upstream", `GitHub ${this.fullName}#${number}: status ${res.status}`);
    return (await res.json()) as GhPull;
  }

  pullFiles(number: number): Promise<GhFile[]> {
    return ghPages<GhFile>(this.app, this.token, `files of ${this.fullName}#${number}`, `${this.repo}/pulls/${number}/files`, MAX_FILE_PAGES);
  }

  async checkRuns(sha: string): Promise<GhCheckRun[] | null> {
    const runs: GhCheckRun[] = [];
    for (let page = 1; page <= MAX_CHECK_PAGES; page++) {
      const res = await fetch(`${this.app.apiUrl}${this.repo}/commits/${sha}/check-runs?per_page=${PAGE_SIZE}&page=${page}`, { headers: ghHeaders(this.token) });
      if (!res.ok) return null;
      const batch = ((await res.json()) as { check_runs?: GhCheckRun[] }).check_runs ?? [];
      runs.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }
    return runs;
  }

  async review(number: number, headSha: string, verdict: Verdict, body: string): Promise<Answer<{ id: number | null }>> {
    const res = await this.call("POST", `${this.repo}/pulls/${number}/reviews`, {
      commit_id: headSha,
      event: verdict === "approve" ? "APPROVE" : "REQUEST_CHANGES",
      ...(body ? { body } : {}),
    });
    if (res.status !== 200 && res.status !== 201) return { ok: false, notFound: res.status === 404, message: message(res.json) };
    return { ok: true, id: typeof res.json.id === "number" ? res.json.id : null };
  }

  async merge(number: number, headSha: string, method: MergeMethod): Promise<Answer<object>> {
    const res = await this.call("PUT", `${this.repo}/pulls/${number}/merge`, { merge_method: method, sha: headSha });
    // 404: gone; 405: not mergeable (checks, conflicts, protection); 409: head moved; 422: method not allowed.
    if (res.status !== 200) return { ok: false, notFound: res.status === 404, message: message(res.json) };
    return { ok: true };
  }

  async repository(): Promise<RepoInfo> {
    const meta = await this.get(this.repo);
    if (!meta.ok) throw failure("repository", meta);
    const info = (await meta.json()) as { id: number; default_branch: string };
    return { id: info.id, defaultBranch: info.default_branch };
  }

  async tree(branch: string): Promise<TreeInfo | null> {
    const res = await this.get(`${this.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    // 409 is GitHub's answer for a repository with no commits yet.
    if (res.status === 409) return null;
    if (!res.ok) throw failure("git tree", res);
    const tree = (await res.json()) as { sha: string; truncated?: boolean; tree: { type: string }[] };
    return { sha: tree.sha, fileCount: tree.tree.filter((e) => e.type === "blob").length, truncated: tree.truncated === true };
  }

  async archive(branch: string): Promise<ReadableStream<Uint8Array>> {
    const tar = await this.get(`${this.repo}/tarball/${encodeURIComponent(branch)}`);
    if (!tar.ok || !tar.body) throw failure("tarball", tar);
    return tar.body;
  }

  async languages(): Promise<Record<string, number>> {
    const res = await this.get(`${this.repo}/languages`);
    if (!res.ok) throw failure("languages", res);
    return (await res.json()) as Record<string, number>;
  }

  async readFile(path: string, ref: string): Promise<{ text: string; sha: string } | null> {
    const res = await this.call("GET", `${this.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`);
    if (res.status === 404) return null;
    if (res.status !== 200 || typeof res.json.sha !== "string" || typeof res.json.content !== "string") throw refuse(`reading ${path}`, res);
    return { text: unbase64(res.json.content), sha: res.json.sha };
  }

  async branchHead(branch: string): Promise<string> {
    const head = await this.call("GET", `${this.repo}/git/ref/heads/${encodeURIComponent(branch)}`);
    const sha = (head.json.object as { sha?: unknown } | undefined)?.sha;
    if (head.status !== 200 || typeof sha !== "string") throw refuse(`reading ${branch}`, head);
    return sha;
  }

  async createBranch(name: string, sha: string): Promise<void> {
    const ref = await this.call("POST", `${this.repo}/git/refs`, { ref: `refs/heads/${name}`, sha });
    if (ref.status !== 201) throw refuse(`creating ${name}`, ref);
  }

  async putFile(o: { path: string; branch: string; message: string; text: string; sha: string | null }): Promise<void> {
    const put = await this.call("PUT", `${this.repo}/contents/${encodePath(o.path)}`, {
      message: o.message,
      content: base64(o.text),
      ...(o.sha ? { sha: o.sha } : {}),
      branch: o.branch,
    });
    if (put.status !== 200 && put.status !== 201) throw refuse(`committing ${o.path}`, put);
  }

  async openPull(o: { title: string; head: string; base: string; body: string }): Promise<{ number: number; url: string }> {
    const pr = await this.call("POST", `${this.repo}/pulls`, o);
    if (pr.status !== 201 || typeof pr.json.number !== "number" || typeof pr.json.html_url !== "string") throw refuse("opening the pull request", pr);
    return { number: pr.json.number, url: pr.json.html_url };
  }
}

/** The installation that owns a repo: one of the project owner's installations on the repo's account. */
export async function installationFor(env: Bindings, projectId: string, fullName: string): Promise<number | null> {
  const owner = fullName.split("/")[0] ?? "";
  const row = await env.DB.prepare(
    `SELECT gi.id FROM github_installations gi
       JOIN user_installations ui ON ui.installation_id = gi.id
       JOIN projects p ON p.owner_id = ui.user_id
      WHERE p.id = ?1 AND gi.account_login = ?2 COLLATE NOCASE
      ORDER BY gi.id LIMIT 1`,
  )
    .bind(projectId, owner)
    .first<{ id: number }>();
  return row?.id ?? null;
}

/** For the sync job: a known installation, else one GitHub lists for the repo that the owner may use. */
export async function githubForSync(env: Bindings, projectId: string, fullName: string): Promise<GithubRepo> {
  const app = appConfigFromEnv(env);
  let installationId = await installationFor(env, projectId, fullName);
  if (installationId === null) {
    const owner = await env.DB.prepare("SELECT owner_id FROM projects WHERE id = ?1").bind(projectId).first<{ owner_id: string }>();
    if (owner) installationId = await linkRepoInstallation(app, env.DB, owner.owner_id, fullName);
  }
  if (installationId === null) throw new PermanentError(`no GitHub App installation for ${fullName}; install the app on its owner first`);
  const token = await installationToken(app, installationId);
  if (token === null) throw new PermanentError(`GitHub no longer knows installation ${installationId}`);
  return new GithubRepo(app, token, fullName);
}

/** For the index job: the installation GitHub says covers this repo, and only if the project's owner may use it. */
export async function githubForIndex(env: Bindings, ownerId: string, fullName: string): Promise<GithubRepo> {
  let app: AppConfig;
  try {
    app = appConfigFromEnv(env);
  } catch (error) {
    throw new PermanentError(error instanceof Error ? error.message : String(error));
  }
  const notInstalled = new PermanentError(`the spectrace GitHub App is not installed on ${fullName}`);
  let res: Response;
  try {
    res = await fetch(`${app.apiUrl}/repos/${fullName}/installation`, { headers: ghHeaders(await appJwt(app)) });
  } catch (cause) {
    if (cause instanceof AppError) throw new PermanentError(cause.message);
    throw new Error(`GitHub installation lookup: ${String(cause)}`, { cause });
  }
  if (res.status === 404) throw notInstalled;
  if (!res.ok) throw failure("installation lookup", res);
  const { id } = (await res.json()) as { id: number };
  const allowed = await env.DB.prepare("SELECT 1 AS ok FROM user_installations WHERE user_id = ?1 AND installation_id = ?2").bind(ownerId, id).first();
  // Installed on GitHub but never linked to this person (for example, installed outside spectrace's install page).
  if (!allowed && (await linkRepoInstallation(app, env.DB, ownerId, fullName)) !== id) throw notInstalled;
  const token = await installationToken(app, id);
  if (!token) throw new PermanentError(`the spectrace GitHub App is no longer installed (${fullName})`);
  return new GithubRepo(app, token, fullName);
}

/** For a request that acts on GitHub: refuses with 409 when the App cannot reach the repo. */
export async function githubForWrite(env: Bindings, projectId: string, fullName: string): Promise<GithubRepo> {
  const installationId = await installationFor(env, projectId, fullName);
  if (installationId === null) throw new AppError("conflict", `conflict: no GitHub App installation for ${fullName}; install the app on its owner first`);
  const app = appConfigFromEnv(env);
  const token = await installationToken(app, installationId);
  if (token === null) throw new AppError("conflict", `conflict: GitHub no longer knows the installation for ${fullName}`);
  return new GithubRepo(app, token, fullName);
}
