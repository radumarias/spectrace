import { useId, useState, type KeyboardEvent } from "react";
import type { GithubRepo } from "../api/queries";
import { Button } from "./parts";

export type RepoPick = { full_name: string; github_repo_id?: number; default_branch?: string };

/** `https://github.com/owner/repo(.git)` or `owner/repo` to `owner/repo`. */
export const normRepo = (v: string) =>
  v.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "").replace(/\/+$/, "");
export const validRepo = (v: string) => /^[\w.-]+\/[\w.-]+$/.test(v);

/** Repo chips, an owner/repo input, and suggestions from GitHub. `value` is controlled by the form. */
export function RepoField({
  value,
  onChange,
  suggestions,
}: {
  value: RepoPick[];
  onChange: (next: RepoPick[]) => void;
  suggestions: GithubRepo[];
}) {
  const id = useId();
  const [input, setInput] = useState("");
  const [err, setErr] = useState("");

  const has = (name: string) => value.some((r) => r.full_name.toLowerCase() === name.toLowerCase());

  function add(raw: string, pick?: GithubRepo) {
    const name = normRepo(raw);
    let e = "";
    if (!name) e = "Type a repo first, like owner/repo.";
    else if (!validRepo(name)) e = "That does not look like owner/repo.";
    else if (has(name)) e = `${name} is already in this project.`;
    setErr(e);
    if (e) return;
    const known = pick ?? suggestions.find((s) => s.full_name.toLowerCase() === name.toLowerCase());
    onChange([
      ...value,
      known ? { full_name: known.full_name, github_repo_id: known.id, default_branch: known.default_branch } : { full_name: name },
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
  const shown = suggestions.filter((s) => !has(s.full_name) && (!q || s.full_name.toLowerCase().includes(q))).slice(0, 5);

  return (
    <div className="fld">
      <label htmlFor={id}>Repositories</label>
      <div className="btns" style={{ gap: 6 }}>
        {value.length ? (
          value.map((r) => (
            <span className="repo-chip" key={r.full_name}>
              {r.full_name}
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
          placeholder="owner/repo or a GitHub link"
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
    </div>
  );
}
