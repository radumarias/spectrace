import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { usePulls, useSyncPulls, type Pull, type PullFilter } from "../api/pulls";
import { useCurrentProject } from "../api/queries";
import { IndexBanner } from "../ui/IndexBanner";
import { IndexFailed } from "../ui/IndexFailed";
import { Button, Pill, type PillTone } from "../ui/parts";
import { useToast } from "../ui/Toast";

const TABS: { id: PullFilter; label: string }[] = [
  { id: "needs", label: "Needs you" },
  { id: "open", label: "Open" },
  { id: "merged", label: "Merged" },
];

const EMPTY: Record<PullFilter, string> = {
  needs: "Nothing needs you here. New PRs show up when you pull from GitHub, or on their own every few minutes.",
  open: "No pull requests in this view.",
  merged: "No pull requests in this view.",
};

/** "3 min ago", "2 h ago", "5 d ago" for an ISO timestamp. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (Number.isNaN(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function status(p: Pull): { tone: PillTone; text: string } {
  if (p.state === "merged") return { tone: "ok", text: "merged" };
  if (p.state === "closed") return { tone: "idle", text: "closed" };
  if (p.draft) return { tone: "idle", text: "draft" };
  return { tone: "warn", text: "open" };
}

function testsTone(p: Pull): PillTone {
  if (p.testsTotal === 0) return "idle";
  if (p.testsFailed > 0) return "bad";
  return p.testsPassed === p.testsTotal ? "ok" : "warn";
}

function PullRow({ pull }: { pull: Pull }) {
  const st = status(pull);
  return (
    <Link className="card pr-row" to={`/pr/${pull.id}`}>
      <div className="stack-s" style={{ minWidth: 0 }}>
        <span className="meta">{pull.repo} #{pull.number} · {pull.author} · {ago(pull.updatedAt)}</span>
        <b style={{ font: "600 15.5px var(--f-display)" }}>{pull.title}</b>
        <div className="btns" style={{ gap: 6 }}>
          <Pill tone={testsTone(pull)}>{pull.testsTotal === 0 ? "tests not run" : `tests ${pull.testsPassed}/${pull.testsTotal}`}</Pill>
          <Pill tone="idle">risk not rated</Pill>
          <Pill tone="idle">+{pull.additions} −{pull.deletions} · {pull.changedFiles} {pull.changedFiles === 1 ? "file" : "files"}</Pill>
        </div>
      </div>
      <div className="stack-s" style={{ alignItems: "flex-end" }}>
        <Pill tone={st.tone}>{st.text}</Pill>
        {pull.needsYou && <span className="mono" style={{ fontSize: 11, color: "var(--warn)" }}>needs you</span>}
      </div>
    </Link>
  );
}

export function PullRequests() {
  const { project, isPending } = useCurrentProject();
  const [filter, setFilter] = useState<PullFilter>("needs");
  const [repo, setRepo] = useState<string | null>(null);
  const list = usePulls(project?.id, filter, repo);
  const sync = useSyncPulls(project?.id ?? "");
  const toast = useToast();
  if (isPending) return null;
  if (!project) return <Navigate to="/projects" replace />;

  const indexing = project.repos.some((r) => r.index_state === "pending" || r.index_state === "indexing");
  const counts = list.data?.counts;
  const needs = counts?.needs ?? 0;
  const pulls = list.data?.pulls ?? [];
  const n = project.repos.length;
  const pull = () =>
    sync.mutate(undefined, {
      onSuccess: () => toast("Pulling from GitHub…"),
      onError: (e) => toast(e.message),
    });

  return (
    <div className="page">
      <div className="head">
        <div>
          <span className="eyebrow">Pull requests · {project.name}</span>
          <h1>{!counts ? "Pull requests" : needs ? `${needs} pull ${needs === 1 ? "request needs" : "requests need"} you` : "Nothing waits on you"}</h1>
          <p className="sub">From {n} {n === 1 ? "repo" : "repos"}. Agents review each one against the specs before you look.</p>
        </div>
        <Button variant="primary" onClick={pull} disabled={sync.isPending || indexing}>
          {sync.isPending ? "Pulling from GitHub…" : "Pull from GitHub"}
        </Button>
      </div>
      {indexing && <IndexBanner project={project} />}
      <IndexFailed project={project} />
      <div className="btns" style={{ justifyContent: "space-between" }}>
        <div className="seg" role="group" aria-label="Filter">
          {TABS.map((t) => (
            <button key={t.id} type="button" className={filter === t.id ? "on" : undefined} aria-pressed={filter === t.id} onClick={() => setFilter(t.id)}>
              {t.label} · {counts ? (t.id === "needs" ? counts.needs : t.id === "open" ? counts.open : counts.merged) : "…"}
            </button>
          ))}
        </div>
        {n > 1 && (
          <div className="seg" role="group" aria-label="Repo">
            {[null, ...project.repos.map((r) => r.full_name)].map((r) => (
              <button key={r ?? "all"} type="button" className={repo === r ? "on" : undefined} aria-pressed={repo === r} onClick={() => setRepo(r)}>
                {r === null ? "All repos" : (r.split("/")[1] ?? r)}
              </button>
            ))}
          </div>
        )}
      </div>
      {list.error ? (
        <div className="card pad err" role="alert">{list.error.message}</div>
      ) : (
        <div className="stack">
          {list.isPending ? null : pulls.length ? (
            pulls.map((p) => <PullRow key={p.id} pull={p} />)
          ) : (
            <div className="card pad sub">{EMPTY[filter]}</div>
          )}
        </div>
      )}
    </div>
  );
}
