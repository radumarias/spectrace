import { useId, useState, type KeyboardEvent } from "react";
import type { GithubRepo, GitlabRepo, Provider } from "../api/queries";
import { Button } from "./parts";

export type RepoPick = { full_name: string; provider?: Provider; github_repo_id?: number; default_branch?: string };

/** `https://github.com/owner/repo(.git)` or `owner/repo` to `owner/repo`. */
export const normRepo = (v: string) =>
  v.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "").replace(/\/+$/, "");
export const validRepo = (v: string) => /^[\w.-]+\/[\w.-]+$/.test(v);

/** A link into the GitLab instance (`https://gitlab.example.com/group/sub/name`, `/-/merge_requests/3`, `.git`) as `group/sub/name`, or null. */
export function gitlabRepoOf(v: string, gitlabUrl: string | null | undefined): string | null {
  if (!gitlabUrl) return null;
  const host = gitlabUrl.replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
  const t = v.trim().replace(/^https?:\/\//i, "");
  if (!t.toLowerCase().startsWith(`${host}/`)) return null;
  return t.slice(host.length + 1).split(/[?#]/)[0]!.split("/-/")[0]!.replace(/\/+$/, "").replace(/\.git$/i, "");
}
const validGitlab = (v: string) => /^[\w.-]+(\/[\w.-]+)+$/.test(v);

type Suggestion = { provider: Provider; full_name: string; id?: number; default_branch: string };

/** Repo chips, an owner/repo input, and suggestions from GitHub (and GitLab, when connected). `value` is controlled by the form. */
export function RepoField({
  value,
  onChange,
  suggestions: github,
  gitlab = [],
  gitlabUrl = null,
}: {
  value: RepoPick[];
  onChange: (next: RepoPick[]) => void;
  suggestions: GithubRepo[];
  gitlab?: GitlabRepo[];
  gitlabUrl?: string | null;
}) {
  const suggestions: Suggestion[] = [
    ...github.map((r) => ({ provider: "github" as const, full_name: r.full_name, id: r.id, default_branch: r.default_branch })),
    ...gitlab.map((r) => ({ provider: "gitlab" as const, full_name: r.full_name, default_branch: r.default_branch })),
  ];
  const id = useId();
  const [input, setInput] = useState("");
  const [err, setErr] = useState("");

  const has = (name: string) => value.some((r) => r.full_name.toLowerCase() === name.toLowerCase());

  function add(raw: string, pick?: Suggestion) {
    const fromGitlab = gitlabRepoOf(raw, gitlabUrl);
    const name = pick?.full_name ?? fromGitlab ?? normRepo(raw);
    const known = pick ?? suggestions.find((s) => s.full_name.toLowerCase() === name.toLowerCase());
    const provider: Provider = known?.provider ?? (fromGitlab !== null ? "gitlab" : "github");
    let e = "";
    if (!name) e = "Type a repo first, like owner/repo.";
    else if (!(provider === "gitlab" ? validGitlab(name) : validRepo(name))) e = "That does not look like owner/repo.";
    else if (has(name)) e = `${name} is already in this project.`;
    setErr(e);
    if (e) return;
    onChange([
      ...value,
      known
        ? { full_name: known.full_name, ...(known.provider === "gitlab" ? { provider: "gitlab" as const } : { github_repo_id: known.id }), default_branch: known.default_branch }
        : provider === "gitlab"
          ? { full_name: name, provider }
          : { full_name: name },
    ]);
    setInput("");
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      add(input);
    }
  }

  const q = input.trim().toLowerCase();
  const match = (s: Suggestion) => !has(s.full_name) && (!q || s.full_name.toLowerCase().includes(q));
  const shown = suggestions.filter((s) => s.provider === "github" && match(s)).slice(0, 5);
  const shownGitlab = suggestions.filter((s) => s.provider === "gitlab" && match(s)).slice(0, 5);

  return (
    <div className="fld">
      <label htmlFor={id}>Repositories</label>
      <div className="btns" style={{ gap: 6 }}>
        {value.length ? (
          value.map((r) => (
            <span className="repo-chip" key={r.full_name}>
              {r.full_name}
              {r.provider === "gitlab" && <span className="sub" style={{ fontSize: 11 }}>GitLab</span>}
              <button type="button" aria-label={`Remove ${r.full_name}`} onClick={() => onChange(value.filter((x) => x !== r))}>
                ×
              </button>
            </span>
          ))
        ) : (
          <span className="sub" style={{ fontSize: 12.5 }}>No repos yet. Add at least one.</span>
        )}
      </div>
      <div className="btns" style={{ flexWrap: "nowrap" }}>
        <input
          id={id}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder={gitlabUrl ? "owner/repo, or a GitHub or GitLab link" : "owner/repo or a GitHub link"}
          autoComplete="off"
          spellCheck={false}
        />
        <Button onClick={() => add(input)}>Add</Button>
      </div>
      {err && <span className="err" role="alert">{err}</span>}
      {shown.length > 0 && (
        <div className="btns" style={{ gap: 6 }}>
          <span className="sub" style={{ fontSize: 12 }}>From your GitHub:</span>
          {shown.map((s) => (
            <button type="button" className="chip" key={s.full_name} onClick={() => add(s.full_name, s)}>
              + {s.full_name}
            </button>
          ))}
        </div>
      )}
      {shownGitlab.length > 0 && (
        <div className="btns" style={{ gap: 6 }}>
          <span className="sub" style={{ fontSize: 12 }}>From your GitLab:</span>
          {shownGitlab.map((s) => (
            <button type="button" className="chip" key={`gl-${s.full_name}`} onClick={() => add(s.full_name, s)}>
              + {s.full_name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
