import { Link, Navigate } from "react-router-dom";
import { useCurrentProject } from "../api/queries";
import { IndexBanner } from "../ui/IndexBanner";
import { Pill, type PillTone } from "../ui/parts";

type Tile = { key: string; value: number | string; note: string; tone: PillTone; to: string };

export function ProjectHome() {
  const { project, isPending } = useCurrentProject();
  if (isPending) return null;
  if (!project) return <Navigate to="/projects" replace />;
  const indexing = project.repos.some((r) => r.index_state === "pending" || r.index_state === "indexing");
  const n = project.repos.length;
  const tiles: Tile[] = [
    { key: "Needs you", value: 0, note: "all clear", tone: "ok", to: "/prs" },
    { key: "Open PRs", value: 0, note: `across ${n} ${n === 1 ? "repo" : "repos"}`, tone: "idle", to: "/prs" },
    { key: "Specs", value: indexing ? "…" : 0, note: "drafted from code", tone: "acc", to: "/spec" },
    { key: "Repos", value: n, note: "edit in settings", tone: "idle", to: "/project" },
  ];
  return (
    <div className="page">
      <div className="head">
        <div>
          <span className="eyebrow">Home · {project.name}</span>
          <h1>{indexing ? `Setting up ${project.name}` : "All clear"}</h1>
          <p className="sub">{project.repos.map((r) => r.full_name).join(" · ")}</p>
        </div>
        <Link className="btn pri" to="/prs" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
          Open pull requests
        </Link>
      </div>
      {indexing && <IndexBanner project={project} />}
      <div className="tiles">
        {tiles.map((t) => (
          <Link className="tile" to={t.to} key={t.key}>
            <span className="lbl">{t.key}</span>
            <b>{t.value}</b>
            <Pill tone={t.tone}>{t.note}</Pill>
          </Link>
        ))}
      </div>
      <section className="stack" aria-label="Context">
        <h2>Context</h2>
        <div className="card pad stack">
          <p className="sub" style={{ fontSize: 13, whiteSpace: "pre-line" }}>
            {project.context || "No context yet. Tell agents what matters in this project."}
          </p>
          <Link to="/project" style={{ fontSize: 12.5 }}>Edit context and repos</Link>
        </div>
      </section>
    </div>
  );
}
