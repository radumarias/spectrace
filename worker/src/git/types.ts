// The git host behind a project repository. spectrace stores pull requests,
// files and CI runs in one shape (GitHub's, see src/pulls.ts and
// src/checks.ts); each provider reads its own API and answers in that shape.
// GitLab merge requests are pull requests here: `number` is the MR's iid.
import type { GhCheckRun } from "../checks";
import type { GhFile, GhPull } from "../pulls";

export const PROVIDERS = ["github", "gitlab"] as const;
export type Provider = (typeof PROVIDERS)[number];

/** How each provider names itself in messages. */
export const PROVIDER_NAME: Record<Provider, string> = { github: "GitHub", gitlab: "GitLab" };

export type MergeMethod = "merge" | "squash" | "rebase";

export type Verdict = "approve" | "request_changes";

/** A refusal from the host: the person can act on `message`. */
export type Answer<T> = ({ ok: true } & T) | { ok: false; notFound: boolean; message: string };

/** The repository as the host describes it. */
export interface RepoInfo {
  /** The host's numeric id of the repository. */
  id: number;
  defaultBranch: string;
}

/** The files of one commit, as far as the host lists them. */
export interface TreeInfo {
  sha: string;
  fileCount: number;
  truncated: boolean;
}

/**
 * One repository on one host, with the credentials for it already resolved.
 *
 * Reads made by jobs throw `PermanentError` when trying again cannot help (not
 * found, no access) and a plain error when it can (5xx, rate limits). Writes
 * that the host refuses come back as `ok: false` or throw a 409 `AppError`
 * carrying the host's own message.
 */
export interface RepoClient {
  readonly provider: Provider;
  readonly fullName: string;

  // Sync
  openPulls(): Promise<GhPull[]>;
  /** The most recently closed (merged or not) pull requests, newest first; files are not read for these. */
  recentlyClosedPulls(): Promise<GhPull[]>;
  /** One pull request, or null when the host does not know it. */
  pull(number: number): Promise<GhPull | null>;
  pullFiles(number: number): Promise<GhFile[]>;
  /** CI runs of a commit; null when the host would not say (missing permission). */
  checkRuns(sha: string): Promise<GhCheckRun[] | null>;

  // Pull request actions
  review(number: number, headSha: string, verdict: Verdict, body: string): Promise<Answer<{ id: number | null }>>;
  merge(number: number, headSha: string, method: MergeMethod): Promise<Answer<object>>;

  // Index
  repository(): Promise<RepoInfo>;
  /** Null for a repository with no commits yet. */
  tree(branch: string): Promise<TreeInfo | null>;
  /** The branch as one `.tar.gz` whose entries sit under a single top folder. */
  archive(branch: string): Promise<ReadableStream<Uint8Array>>;
  /** Language name to a weight (bytes on GitHub, percent on GitLab). */
  languages(): Promise<Record<string, number>>;

  // Writes (specs and requirements open pull requests)
  /** The text of a file on a branch, and its blob id; null when there is none. */
  readFile(path: string, ref: string): Promise<{ text: string; sha: string } | null>;
  branchHead(branch: string): Promise<string>;
  createBranch(name: string, sha: string): Promise<void>;
  /** Create (`sha` null) or update (`sha` of the blob being replaced) one file in one commit. */
  putFile(o: { path: string; branch: string; message: string; text: string; sha: string | null }): Promise<void>;
  openPull(o: { title: string; head: string; base: string; body: string }): Promise<{ number: number; url: string }>;
}
