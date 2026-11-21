import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { useCurrentProject } from "../api/queries";
import { usePull, type PullDetail as Pull } from "../api/pulls";
import { Button, Card, Pill, Tabs, type PillTone } from "../ui/parts";

const STATE: Record<Pull["state"], { tone: PillTone; label: string }> = {
  open: { tone: "acc", label: "open" },
  merged: { tone: "ok", label: "merged" },
  closed: { tone: "idle", label: "closed" },
};

function BackLink() {
  return (
    <Link className="btn ghost sm" to="/prs" style={{ textDecoration: "none", alignSelf: "flex-start", paddingLeft: 0 }}>
      ← Pull requests
    </Link>
  );
}

function Message({ children }: { children: ReactNode }) {
  return (
    <div className="page">
      <div className="head"><div><BackLink /></div></div>
      <Card><p className="sub">{children}</p></Card>
    </div>
  );
}

export function PullDetail() {
  const { pullId } = useParams();
  const { project, isPending } = useCurrentProject();
  const pull = usePull(project?.id, pullId);
  const [tab, setTab] = useState("walk");

  if (isPending || (project && pull.isPending)) return null;
  if (!project) return <Message>Pick a project to see its pull requests.</Message>;
  if (pull.error?.message === "not_found") return <Message>This pull request is not in {project.name}.</Message>;
  if (!pull.data) return <Message>{pull.error?.message ?? "Could not load the pull request."}</Message>;

  const p = pull.data;
  const s = STATE[p.state];
  return (
    <div className="page">
      <div className="head">
        <div>
          <BackLink />
          <span className="mono sub" style={{ fontSize: 12 }}>
            {p.repo} #{p.number} · {p.headRef} → {p.baseRef} · by {p.author}
          </span>
          <h1>{p.title}</h1>
          <div className="btns" style={{ gap: 6 }}>
            <Pill tone={s.tone}>{s.label}</Pill>
            {p.draft && <Pill tone="idle">draft</Pill>}
            <Pill tone="idle">checks not synced yet</Pill>
            <Pill tone="idle">{p.changedFiles} {p.changedFiles === 1 ? "file" : "files"} changed</Pill>
          </div>
        </div>
        <div className="stack-s" style={{ alignItems: "flex-end" }}>
          <div className="btns">
            {/* Wired up by T2.6 (approve, request changes, merge). */}
            <Button disabled>Request changes</Button>
            <Button disabled>Approve</Button>
            <Button variant="primary" disabled>{p.state === "merged" ? "Merged" : "Merge PR"}</Button>
          </div>
          <span className="sub" style={{ fontSize: 12, textAlign: "right", maxWidth: 340 }}>
            Approve and merge arrive with the next update.
          </span>
        </div>
      </div>

      <Tabs
        items={[{ id: "walk", label: "Walkthrough" }, { id: "files", label: `Files · ${p.files.length}` }]}
        value={tab}
        onChange={setTab}
      />

      {tab === "walk" ? <Walkthrough pull={p} /> : <Files pull={p} />}
    </div>
  );
}

function Walkthrough({ pull: p }: { pull: Pull }) {
  return (
    <div className="row">
      <div className="main stack">
        <Card className="stack">
          <span className="lbl">What this PR does</span>
          <p className="pr-body">{p.body.trim() || "The author did not write a description."}</p>
        </Card>
      </div>
      <div className="aside stack">
        <Card className="stack">
          <span className="lbl">Checks</span>
          <p className="sub" style={{ fontSize: 13 }}>CI results show up here once they are synced from GitHub.</p>
        </Card>
        <Card className="stack">
          <span className="lbl">Size</span>
          <span className="mono" style={{ fontSize: 13 }}>
            <span style={{ color: "var(--ok)" }}>+{p.additions}</span> <span style={{ color: "var(--bad)" }}>−{p.deletions}</span> in {p.changedFiles}{" "}
            {p.changedFiles === 1 ? "file" : "files"}
          </span>
          <a href={p.htmlUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12.5 }}>Open on GitHub</a>
        </Card>
      </div>
    </div>
  );
}

function Files({ pull: p }: { pull: Pull }) {
  if (p.files.length === 0) return <Card><p className="sub">No changed files are stored for this pull request yet.</p></Card>;
  return (
    <div className="card tbl-wrap">
      <table className="tbl" style={{ minWidth: 420 }}>
        <thead>
          <tr><th>File</th><th>Status</th><th className="num">Change</th></tr>
        </thead>
        <tbody>
          {p.files.map((f) => (
            <tr key={f.path}>
              <td>
                <code style={{ overflowWrap: "anywhere" }}>{f.path}</code>
                {f.previousPath && <div className="mono sub" style={{ fontSize: 11 }}>from {f.previousPath}</div>}
              </td>
              <td><Pill tone={f.status === "added" ? "ok" : f.status === "removed" ? "bad" : "idle"}>{f.status}</Pill></td>
              <td className="num mono" style={{ fontSize: 12 }}>
                <span style={{ color: "var(--ok)" }}>+{f.additions}</span> <span style={{ color: "var(--bad)" }}>−{f.deletions}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
