import type { Project } from "../api/queries";

/** Shown while repos are being indexed. */
export function IndexBanner({ project }: { project: Project }) {
  const total = project.repos.length;
  const ready = project.repos.filter((r) => r.index_state === "ready").length;
  return (
    <div className="card pad stack" style={{ borderColor: "var(--accent)" }}>
      <div className="btns" style={{ justifyContent: "space-between" }}>
        <b>Indexing · {ready} of {total} {total === 1 ? "repo" : "repos"} ready…</b>
        <span className="mono sub" style={{ fontSize: 12 }}>{Math.round((ready / Math.max(total, 1)) * 100)}%</span>
      </div>
      <div className="bar"><i className="b-acc" style={{ width: `${(ready / Math.max(total, 1)) * 100}%` }} /></div>
      <span className="sub" style={{ fontSize: 12.5 }}>
        {project.repos.map((r) => r.full_name).join(", ")}. Open PRs show up here as soon as indexing ends.
      </span>
    </div>
  );
}
