import { useEffect, useRef, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { clearCurrentProjectId } from "../api/current";
import { useCurrentProject, useDeleteProject, useGithubRepos, useUpdateProject, type Project, type ProjectChange } from "../api/queries";
import { Button, PageHead } from "../ui/parts";
import { RepoField, type RepoPick } from "../ui/RepoField";
import { IndexBanner } from "../ui/IndexBanner";
import { useToast } from "../ui/Toast";

const CTX_HINT =
  "What agents and reviewers should know. For example: what is critical, who owns what, conventions, things never to change.";
const SAVE_DELAY = 600;

const asPicks = (p: Project): RepoPick[] =>
  p.repos.map((r) => ({
    full_name: r.full_name,
    default_branch: r.default_branch,
    ...(r.github_repo_id === null ? {} : { github_repo_id: r.github_repo_id }),
  }));

function Settings({ project }: { project: Project }) {
  const navigate = useNavigate();
  const toast = useToast();
  const update = useUpdateProject(project.id);
  const remove = useDeleteProject(project.id);
  const github = useGithubRepos();
  const [name, setName] = useState(project.name);
  const [context, setContext] = useState(project.context);
  const [repos, setRepos] = useState<RepoPick[]>(() => asPicks(project));
  const [confirm, setConfirm] = useState(false);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState("");
  const pending = useRef<ProjectChange>({});
  const timer = useRef<number>();
  const { mutate } = update;

  function flush() {
    window.clearTimeout(timer.current);
    const body = pending.current;
    pending.current = {};
    if (Object.keys(body).length === 0) return;
    setStatus("saving");
    mutate(body, {
      onSuccess: () => {
        setError("");
        setStatus("saved");
      },
      onError: (e) => {
        setError(e.message);
        setStatus("idle");
      },
    });
  }

  /** Changes save as you type: collect them and send one request shortly after the last key. */
  function change(next: ProjectChange, now = false) {
    pending.current = { ...pending.current, ...next };
    window.clearTimeout(timer.current);
    if (now) flush();
    else timer.current = window.setTimeout(flush, SAVE_DELAY);
  }

  // Leaving the page must not lose the last keystrokes.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => flushRef.current(), []);

  const nameBad = name.trim() === "";
  const indexing = project.repos.some((r) => r.index_state === "pending" || r.index_state === "indexing");

  function onRepos(next: RepoPick[]) {
    setRepos(next);
    change({ repos: next }, true);
  }

  function removeProject() {
    window.clearTimeout(timer.current);
    pending.current = {};
    remove.mutate(undefined, {
      onSuccess: () => {
        clearCurrentProjectId();
        toast(`${project.name} removed from spectrace.`);
        navigate("/projects");
      },
    });
  }

  return (
    <div className="page" style={{ maxWidth: 820 }}>
      <PageHead eyebrow="Project settings" title={project.name} sub="Changes save as you type. Agents pick up new context on their next task.">
        <Button
          disabled
          title="Re-indexing arrives with the index job (T1.6). Repos you add are indexed when it lands."
        >
          {indexing ? "Indexing…" : "Re-index repos"}
        </Button>
      </PageHead>
      {indexing && <IndexBanner project={project} />}
      <div className="card pad stack" style={{ gap: 18 }}>
        <div className="fld">
          <label htmlFor="ps-name">Name</label>
          <input
            id="ps-name"
            value={name}
            maxLength={40}
            autoComplete="off"
            onChange={(e) => {
              setName(e.target.value);
              if (e.target.value.trim() !== "") change({ name: e.target.value.trim() });
            }}
          />
          {nameBad && <span className="err" role="alert">Give the project a name.</span>}
        </div>
        <RepoField value={repos} onChange={onRepos} suggestions={github.data ?? []} />
        <div className="fld">
          <label htmlFor="ps-ctx">Context</label>
          <textarea
            id="ps-ctx"
            rows={6}
            value={context}
            placeholder={CTX_HINT}
            onChange={(e) => {
              setContext(e.target.value);
              change({ context: e.target.value });
            }}
            onBlur={flush}
          />
          <span style={{ fontSize: 12 }}>Agents read this before every task and every PR review.</span>
        </div>
        <div className="btns" style={{ justifyContent: "space-between", minHeight: 20 }}>
          {error ? <span className="err" role="alert">{error}</span> : <span />}
          <span className="sub" role="status" style={{ fontSize: 12 }}>
            {status === "saving" ? "Saving…" : status === "saved" ? "Saved" : ""}
          </span>
        </div>
      </div>
      <div className="card pad btns" style={{ justifyContent: "space-between" }}>
        <div className="stack-s" style={{ gap: 2 }}>
          <b>Remove this project</b>
          <span className="sub" style={{ fontSize: 12.5 }}>Only removes it from spectrace. Repos and PRs on GitHub stay as they are.</span>
        </div>
        {confirm ? (
          <div className="btns">
            <Button onClick={() => setConfirm(false)}>Keep it</Button>
            <Button style={{ borderColor: "var(--bad)", color: "var(--bad)" }} disabled={remove.isPending} onClick={removeProject}>
              Yes, remove
            </Button>
          </div>
        ) : (
          <Button onClick={() => setConfirm(true)}>Remove project</Button>
        )}
      </div>
      {remove.error && <span className="err" role="alert">{remove.error.message}</span>}
    </div>
  );
}

export function ProjectSettings() {
  const { project, isPending } = useCurrentProject();
  if (isPending) return null;
  if (!project) return <Navigate to="/projects" replace />;
  return <Settings key={project.id} project={project} />;
}
