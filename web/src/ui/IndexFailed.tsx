import type { Project } from "../api/queries";

/** Failed repos of a project with the reason GitHub or the Worker gave. */
export const failedRepos = (p: Project) => p.repos.filter((r) => r.index_state === "failed");

/** The App is missing from the repo's owner: the fix is to install it, so offer that. */
const needsInstall = (reason: string | null) => /not installed|no github app installation/i.test(reason ?? "");

/** Shown when indexing failed: says why, and links to the GitHub App install page when that is the cause. */
export function IndexFailed({ project }: { project: Project }) {
  const failed = failedRepos(project);
  if (failed.length === 0) return null;
  const install = failed.some((r) => needsInstall(r.index_error));
  return (
    <div className="card pad stack err" role="alert">
      <b>Indexing failed</b>
      {failed.map((r) => (
        <span key={r.id} className="sub" style={{ fontSize: 13 }}>
          <span className="mono">{r.full_name}</span>: {r.index_error ?? "unknown error"}
        </span>
      ))}
      {install && (
        <span className="sub" style={{ fontSize: 13 }}>
          Install the GitHub App on the owner of {failed.length === 1 ? "this repository" : "these repositories"}, then come back and re-index in project settings.{" "}
          <a href="/api/github/install">Install the GitHub App</a>
        </span>
      )}
    </div>
  );
}
