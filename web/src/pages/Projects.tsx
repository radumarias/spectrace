import type { KeyboardEvent, MouseEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { setCurrentProjectId } from "../api/current";
import { useProjects, type Project } from "../api/queries";
import { Icon } from "../ui/Icon";
import { Pill } from "../ui/parts";

const mark = (name: string) => (name.trim()[0] ?? "?").toUpperCase();
const repoCount = (n: number) => `${n} ${n === 1 ? "repo" : "repos"}`;

function IndexState({ project }: { project: Project }) {
  const total = project.repos.length;
  const ready = project.repos.filter((r) => r.index_state === "ready").length;
  if (project.repos.some((r) => r.index_state === "failed")) {
    const reason = project.repos.find((r) => r.index_state === "failed")?.index_error;
    return (
      <div className="stack-s" style={{ marginTop: "auto" }}>
        <div className="btns" style={{ gap: 6 }}><Pill tone="bad">indexing failed</Pill></div>
        {reason && <span className="sub" style={{ fontSize: 12 }}>{reason}</span>}
      </div>
    );
  }
  if (ready < total) {
    return (
      <div className="stack-s" style={{ marginTop: "auto" }}>
        <span className="mono sub" style={{ fontSize: 11.5 }}>Indexing · {ready} of {total} repos ready</span>
        <div className="bar"><i className="b-acc" style={{ width: `${(ready / total) * 100}%` }} /></div>
      </div>
    );
  }
  return <div className="btns" style={{ gap: 6, marginTop: "auto" }}><Pill tone="ok">indexed</Pill></div>;
}

function ProjectCard({ project }: { project: Project }) {
  const navigate = useNavigate();
  const open = (to: string) => {
    setCurrentProjectId(project.id);
    navigate(to);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      open("/home");
    }
  };
  const settings = (e: MouseEvent) => {
    e.stopPropagation();
    open("/project");
  };
  return (
    <div className="card proj" role="button" tabIndex={0} aria-label={`Open ${project.name}`} onClick={() => open("/home")} onKeyDown={onKey}>
      <div className="btns" style={{ flexWrap: "nowrap" }}>
        <span className="mark">{mark(project.name)}</span>
        <div className="stack-s" style={{ gap: 2, minWidth: 0, flex: 1 }}>
          <b style={{ font: "600 17px var(--f-display)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{project.name}</b>
          <span className="mono sub" style={{ fontSize: 11 }}>{repoCount(project.repos.length)}</span>
        </div>
        <button type="button" className="icon-btn" aria-label={`Settings for ${project.name}`} onClick={settings}>
          <Icon name="project" size={16} />
        </button>
      </div>
      <div className="btns" style={{ gap: 6 }}>
        {project.repos.slice(0, 3).map((r) => (
          <span className="repo-chip" key={r.id}>{r.full_name}</span>
        ))}
        {project.repos.length > 3 && <span className="repo-chip">+{project.repos.length - 3}</span>}
      </div>
      <p className="sub clamp" style={{ fontSize: 13 }}>{project.context || "No context yet."}</p>
      <IndexState project={project} />
    </div>
  );
}

export function Projects() {
  const { data, error, isPending } = useProjects();
  return (
    <div className="page">
      <div className="head">
        <div>
          <span className="eyebrow">Projects</span>
          <h1>All your projects</h1>
          <p className="sub">
            A project groups the repos that ship together and the context agents should know. Open one to work on its specs and pull requests.
          </p>
        </div>
        <Link className="btn pri" to="/new-project" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}>
          + New project
        </Link>
      </div>
      {error && <span className="err" role="alert">{error.message}</span>}
      {!isPending && (
        <div className="proj-grid">
          {(data ?? []).map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
          <Link className="card proj add" to="/new-project">
            <span style={{ font: "600 28px var(--f-display)" }}>+</span>
            <b>New project</b>
            <span className="sub" style={{ fontSize: 12.5, textAlign: "center" }}>
              Add repos and context. spectrace drafts specs and pulls in open PRs.
            </span>
          </Link>
        </div>
      )}
    </div>
  );
}
