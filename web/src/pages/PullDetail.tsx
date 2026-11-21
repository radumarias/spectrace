import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { useCurrentProject } from "../api/queries";
import { useMergePull, usePull, usePullDiff, usePullReviews, useReviewPull, type PullDetail as Pull } from "../api/pulls";
import { Button, Card, Pill, Tabs, type PillTone } from "../ui/parts";
import { Diff } from "../ui/Diff";
import { Markdown, stripHtmlComments } from "../ui/Markdown";
import { useToast } from "../ui/Toast";

const CHECKS: Record<Pull["checksState"], { tone: PillTone; label: string }> = {
  none: { tone: "idle", label: "no checks" },
  pending: { tone: "warn", label: "checks running" },
  passing: { tone: "ok", label: "checks passing" },
  failing: { tone: "bad", label: "checks failing" },
};

function checkLine(c: Pull["checks"][number]): { tone: PillTone; label: string } {
  if (c.status === "queued") return { tone: "idle", label: "queued" };
  if (c.status === "in_progress") return { tone: "warn", label: "running" };
  const k = c.conclusion ?? "";
  if (k === "success") return { tone: "ok", label: "passed" };
  if (k === "neutral" || k === "skipped") return { tone: "idle", label: k };
  return { tone: "bad", label: k.replace(/_/g, " ") || "failed" };
}

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
            <Pill tone={CHECKS[p.checksState].tone}>{CHECKS[p.checksState].label}</Pill>
            <Pill tone="idle">{p.changedFiles} {p.changedFiles === 1 ? "file" : "files"} changed</Pill>
          </div>
        </div>
        <Actions projectId={project.id} pull={p} />
      </div>

      <Tabs
        items={[{ id: "walk", label: "Walkthrough" }, { id: "files", label: `Files · ${p.files.length}` }]}
        value={tab}
        onChange={setTab}
      />

      {tab === "walk" ? <Walkthrough pull={p} /> : <Files projectId={project.id} pull={p} />}
    </div>
  );
}

function Walkthrough({ pull: p }: { pull: Pull }) {
  return (
    <div className="row">
      <div className="main stack">
        <Card className="stack">
          <span className="lbl">What this PR does</span>
          {stripHtmlComments(p.body).trim() ? <Markdown>{p.body}</Markdown> : <p className="sub">The author did not write a description.</p>}
        </Card>
      </div>
      <div className="aside stack">
        <Card className="stack">
          <span className="lbl">Checks</span>
          {p.checks.length === 0 ? (
            <p className="sub" style={{ fontSize: 13 }}>No check runs for this commit yet. Pull from GitHub on the pull requests page to read them.</p>
          ) : (
            <ul className="checks">
              {p.checks.map((c) => {
                const line = checkLine(c);
                return (
                  <li key={c.name}>
                    {c.url ? <a href={c.url} target="_blank" rel="noreferrer">{c.name}</a> : <span>{c.name}</span>}
                    <Pill tone={line.tone}>{line.label}</Pill>
                  </li>
                );
              })}
            </ul>
          )}
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

function Files({ projectId, pull: p }: { projectId: string; pull: Pull }) {
  const diffs = usePullDiff(projectId, p.id, true);
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (p.files.length === 0) return <Card><p className="sub">No changed files are stored for this pull request yet.</p></Card>;
  const toggle = (path: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  return (
    <div className="stack">
      {diffs.error && <p className="err" role="alert">{diffs.error.message}</p>}
      {p.files.map((f) => {
        const expanded = open.has(f.path);
        const patch = diffs.data?.get(f.path);
        const id = `diff-${f.path}`;
        return (
          <div className="card file" key={f.path}>
            <button className="file-head" type="button" aria-expanded={expanded} aria-controls={id} onClick={() => toggle(f.path)}>
              <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
              <span className="file-name">
                <code>{f.path}</code>
                {f.previousPath && <span className="mono sub" style={{ fontSize: 11 }}>from {f.previousPath}</span>}
              </span>
              <Pill tone={f.status === "added" ? "ok" : f.status === "removed" ? "bad" : "idle"}>{f.status}</Pill>
              <span className="mono" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                <span style={{ color: "var(--ok)" }}>+{f.additions}</span> <span style={{ color: "var(--bad)" }}>−{f.deletions}</span>
              </span>
            </button>
            {expanded && (
              <div id={id} className="file-body">
                {diffs.isPending ? (
                  <p className="sub pad">Loading the changes…</p>
                ) : patch ? (
                  <Diff patch={patch} />
                ) : (
                  <p className="sub pad">
                    No diff to show here: the file is binary, empty, or too large.{" "}
                    <a href={`${p.htmlUrl}/files`} target="_blank" rel="noreferrer">View it on GitHub</a>
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Actions({ projectId, pull: p }: { projectId: string; pull: Pull }) {
  const toast = useToast();
  const reviews = usePullReviews(projectId, p.id);
  const review = useReviewPull(projectId, p.id);
  const merge = useMergePull(projectId, p.id);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const mine = reviews.data?.[0];
  // A review counts for the commit it was left on; a new push starts again.
  const current = mine && mine.headSha === p.headSha ? mine.verdict : null;
  const open = p.state === "open";
  const busy = review.isPending || merge.isPending;

  const send = (verdict: "approve" | "request_changes", body?: string) => {
    setError("");
    review.mutate(
      { verdict, body },
      {
        onSuccess: () => {
          setAsking(false);
          setNote("");
          toast(verdict === "approve" ? "Approved" : "Changes requested");
        },
        onError: (e) => setError(e.message),
      },
    );
  };
  const doMerge = () => {
    setError("");
    merge.mutate(undefined, { onSuccess: () => toast("Merged"), onError: (e) => setError(e.message) });
  };

  return (
    <div className="stack-s" style={{ alignItems: "flex-end" }}>
      <div className="btns">
        {open && (
          <>
            <Button disabled={busy} onClick={() => setAsking((a) => !a)} aria-expanded={asking}>Request changes</Button>
            <Button disabled={busy || current === "approved"} aria-pressed={current === "approved"} onClick={() => send("approve")}>
              {current === "approved" ? "✓ Approved" : "Approve"}
            </Button>
          </>
        )}
        <Button variant={p.state === "merged" ? "default" : "primary"} disabled={!open || p.draft || busy} onClick={doMerge}>
          {p.state === "merged" ? "Merged" : merge.isPending ? "Merging…" : "Merge PR"}
        </Button>
      </div>
      <span className="sub" style={{ fontSize: 12, textAlign: "right", maxWidth: 340 }}>
        {p.state === "merged"
          ? "Merged"
          : p.state === "closed"
            ? "Closed without merging"
            : p.draft
              ? "Draft: mark it ready on GitHub to merge"
              : current === "changes_requested"
                ? "You asked for changes on this commit"
                : current === "approved"
                  ? "You approved this commit"
                  : "Waiting on your review"}
      </span>
      {error && <span className="err" role="alert" style={{ textAlign: "right", maxWidth: 340 }}>{error}</span>}
      {asking && open && (
        <form
          className="fld"
          style={{ width: "min(340px, 100%)" }}
          onSubmit={(e) => {
            e.preventDefault();
            send("request_changes", note.trim());
          }}
        >
          <label htmlFor="changes-note">What should change?</label>
          <textarea id="changes-note" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="btns">
            <Button variant="primary" small type="submit" disabled={busy || note.trim() === ""}>Send</Button>
            <Button small onClick={() => setAsking(false)}>Cancel</Button>
          </div>
        </form>
      )}
    </div>
  );
}
