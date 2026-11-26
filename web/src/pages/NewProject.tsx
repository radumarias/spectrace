import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { setCurrentProjectId } from "../api/current";
import { useCreateProject, useGithubRepos, useGitlab, useGitlabRepos } from "../api/queries";
import { Button } from "../ui/parts";
import { RepoField, type RepoPick } from "../ui/RepoField";
import { useToast } from "../ui/Toast";

const CTX_HINT =
  "What agents and reviewers should know. For example: what is critical, who owns what, conventions, things never to change.";

export function NewProject() {
  const navigate = useNavigate();
  const toast = useToast();
  const create = useCreateProject();
  const github = useGithubRepos();
  const gitlab = useGitlab();
  const gitlabRepos = useGitlabRepos(Boolean(gitlab.data?.account));
  const [name, setName] = useState("");
  const [repos, setRepos] = useState<RepoPick[]>([]);
  const [context, setContext] = useState("");
  const ok = name.trim() !== "" && repos.length > 0;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!ok || create.isPending) return;
    create.mutate(
      { name: name.trim(), context: context.trim(), repos },
      {
        onSuccess: (p) => {
          setCurrentProjectId(p.id);
          toast(`${p.name} created. Indexing its repos.`);
          navigate("/home");
        },
      },
    );
  }

  return (
    <div className="page" style={{ maxWidth: 820 }}>
      <div className="head">
        <div>
          <Link className="btn ghost sm" to="/projects" style={{ textDecoration: "none", alignSelf: "flex-start", paddingLeft: 0 }}>
            ← All projects
          </Link>
          <h1>New project</h1>
          <p className="sub">Group the repos that ship together. You can add more repos and change the context later.</p>
        </div>
      </div>
      <form className="card pad stack" style={{ gap: 18 }} onSubmit={submit}>
        <div className="fld">
          <label htmlFor="np-name">Name</label>
          <input
            id="np-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="for example Mobile app"
            autoComplete="off"
            maxLength={40}
          />
        </div>
        <RepoField value={repos} onChange={setRepos} suggestions={github.data ?? []} gitlab={gitlabRepos.data ?? []} gitlabUrl={gitlab.data?.url ?? null} />
        <div className="fld">
          <label htmlFor="np-ctx">Context</label>
          <textarea id="np-ctx" rows={5} value={context} onChange={(e) => setContext(e.target.value)} placeholder={CTX_HINT} />
          <span style={{ fontSize: 12 }}>Agents read this before every task and every PR review.</span>
        </div>
        {create.error && <span className="err" role="alert">{create.error.message}</span>}
        <div className="btns" style={{ justifyContent: "flex-end" }}>
          <Link className="btn" to="/projects" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
            Cancel
          </Link>
          <Button variant="primary" type="submit" disabled={!ok || create.isPending}>
            Create project
          </Button>
        </div>
      </form>
    </div>
  );
}
