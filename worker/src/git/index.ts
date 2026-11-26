// Picks the provider for a project repository and resolves its credentials.
import type { Bindings } from "../env";
import { AppError } from "../error";
import { PermanentError } from "../jobs/queue";
import { githubForIndex, githubForSync, githubForWrite } from "./github";
import type { Provider, RepoClient } from "./types";

export type { Provider, RepoClient } from "./types";
export { PROVIDER_NAME, PROVIDERS } from "./types";

/**
 * What the client is for, which decides how missing access is reported: the
 * jobs fail for good (`PermanentError`), a request answers 409.
 */
export type Purpose = "sync" | "index" | "write";

/** The provider of a project's repo; GitHub when the repo is not (or no longer) in the project. */
export async function providerOf(env: Bindings, projectId: string, fullName: string): Promise<Provider> {
  const row = await env.DB.prepare("SELECT provider FROM project_repos WHERE project_id = ?1 AND full_name = ?2 COLLATE NOCASE")
    .bind(projectId, fullName)
    .first<{ provider: Provider }>();
  return row?.provider ?? "github";
}

/** A client for one repository of a project, acting with the access the project's owner gave spectrace. */
export async function repoClient(env: Bindings, projectId: string, fullName: string, purpose: Purpose): Promise<RepoClient> {
  const provider = await providerOf(env, projectId, fullName);
  if (provider === "github") {
    if (purpose === "sync") return githubForSync(env, projectId, fullName);
    if (purpose === "write") return githubForWrite(env, projectId, fullName);
    const owner = await env.DB.prepare("SELECT owner_id FROM projects WHERE id = ?1").bind(projectId).first<{ owner_id: string }>();
    if (!owner) throw new PermanentError(`project ${projectId} is gone`);
    return githubForIndex(env, owner.owner_id, fullName);
  }
  const msg = `${provider} repositories are not supported yet`;
  throw purpose === "write" ? new AppError("conflict", `conflict: ${msg}`) : new PermanentError(msg);
}
