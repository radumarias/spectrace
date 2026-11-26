import { useId, useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { hostOfUrl, PROVIDER_NAME, useCurrentProject } from "../api/queries";
import { isCurrentReview, isRunning, useAgentReview, useMergePull, usePull, usePullDiff, usePullReviews, useReviewPull, useRunAgentReview, type AgentReview, type Finding, type PullDetail as Pull, type WalkStep } from "../api/pulls";
import { Button, Card, Pill, Tabs, type PillTone } from "../ui/parts";
import { Diff, type Range } from "../ui/Diff";
import { Inline } from "../ui/Inline";
import { Markdown, stripHtmlComments } from "../ui/Markdown";
import { useToast } from "../ui/Toast";

const CHECKS: Record<Pull["checksState"], { tone: PillTone; label: string }> = {
  none: { tone: "idle", label: "no checks" },
  pending: { tone: "warn", label: "checks running" },
  passing: { tone: "ok", label: "checks passing" },
  failing: { tone: "bad", label: "checks failing" },
};

/** "tests 3/4": check runs that finished well, over all of them (the prototype's wording). */
function testsLabel(p: Pull): string {
  if (p.checks.length === 0) return CHECKS.none.label;
  const ok = p.checks.filter((c) => c.status === "completed" && ["success", "neutral", "skipped"].includes(c.conclusion ?? "")).length;
  return `tests ${ok}/${p.checks.length}`;
}

type Gate = { label: string; ok: boolean; checked: boolean };

/** The merge gates come from the server (the core rules); the page only shows them. */
function toGates(p: Pull): Gate[] {
  return p.gates.map((g) => ({ label: g.label, ok: g.status === "pass", checked: g.status !== "unchecked" }));
}

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
  const agent = useAgentReview(project?.id, pullId);
  const [tab, setTab] = useState("walk");

  if (isPending || (project && pull.isPending)) return null;
  if (!project) return <Message>Pick a project to see its pull requests.</Message>;
  if (pull.error?.message === "not_found") return <Message>This pull request is not in {project.name}.</Message>;
  if (!pull.data) return <Message>{pull.error?.message ?? "Could not load the pull request."}</Message>;

  const p = pull.data;
  const s = STATE[p.state];
  const ar = agent.data;
  const gates = toGates(p);
  const pill = REVIEW_PILL[isRunning(ar) ? "running" : ar?.state === "succeeded" ? "succeeded" : "none"];
  const found = ar?.state === "succeeded" ? ar.findings.length : 0;
  return (
    <div className="page">
      <div className="head">
        <div>
          <BackLink />
          <span className="mono sub" style={{ fontSize: 12 }}>
            {p.repo} {hostOfUrl(p.htmlUrl) === "gitlab" ? "!" : "#"}{p.number} · {p.headRef} → {p.baseRef} · by {p.author}
          </span>
          <h1>{p.title}</h1>
          <div className="btns" style={{ gap: 6 }}>
            <Pill tone={s.tone}>{s.label}</Pill>
            {p.draft && <Pill tone="idle">draft</Pill>}
            <Pill tone={CHECKS[p.checksState].tone}>{testsLabel(p)}</Pill>
            <Pill tone={pill.tone}>{pill.label}</Pill>
            {ar?.state === "succeeded" && ar.risk && <Pill tone={RISK[ar.risk]}>risk {ar.risk.toUpperCase()}</Pill>}
            <Pill tone="idle">{p.changedFiles} {p.changedFiles === 1 ? "file" : "files"} changed</Pill>
          </div>
        </div>
        <Actions projectId={project.id} pull={p} gates={gates} />
      </div>

      <Tabs
        items={[
          { id: "walk", label: "Walkthrough" },
          { id: "files", label: `Files · ${p.files.length}` },
          { id: "findings", label: `Findings${found ? ` · ${found}` : ""}` },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "walk" && <Walkthrough projectId={project.id} pull={p} review={ar} gates={gates} context={project.context} onFindings={() => setTab("findings")} />}
      {tab === "files" && <Files projectId={project.id} pull={p} />}
      {tab === "findings" && <Findings pull={p} review={ar} />}
    </div>
  );
}

const REVIEW_PILL: Record<"none" | "running" | "succeeded", { tone: PillTone; label: string }> = {
  none: { tone: "idle", label: "not reviewed" },
  running: { tone: "acc", label: "reviewing" },
  succeeded: { tone: "ok", label: "reviewed" },
};

/** Progress of a running review, as the prototype words its stages; anything else is still reading. */
const STAGES: Record<string, { label: string; pct: number }> = {
  reviewing: { label: "Finder agents looking for bugs", pct: 30 },
  refuting: { label: "Refuters checking each finding", pct: 60 },
};
const stageOf = (r: AgentReview) => STAGES[r.stage] ?? { label: "Reading the diff and the linked specs", pct: r.state === "running" ? 10 : 0 };

const BACKEND: Record<NonNullable<AgentReview["backend"]>, string> = {
  "claude-code": "your Claude subscription",
  user_key: "your Anthropic API key",
  api: "the server's Anthropic key",
};

/**
 * The review card: "No agent review yet" with the Run button, the stages of
 * a running review, or why the last one failed. Hidden once a review of the
 * head commit finished; a review of an older commit offers to run again.
 */
function ReviewCard({ pull: p, review }: { pull: Pull; review: AgentReview | null | undefined }) {
  const { project } = useCurrentProject();
  const run = useRunAgentReview(project?.id ?? "", p.id);
  const toast = useToast();
  const start = () => run.mutate(undefined, { onSuccess: () => toast("Agent review started"), onError: (e) => toast(e.message) });

  if (isRunning(review)) {
    const s = stageOf(review);
    return (
      <Card className="stack review-run">
        <div className="btns" style={{ justifyContent: "space-between" }}>
          <b>{s.label}…</b>
          <span className="mono sub" style={{ fontSize: 12 }}>{s.pct}%</span>
        </div>
        <div className="bar" role="progressbar" aria-label="Agent review progress" aria-valuenow={s.pct} aria-valuemin={0} aria-valuemax={100}>
          <i className="b-acc" style={{ width: `${Math.max(s.pct, 4)}%` }} />
        </div>
        <span className="sub" style={{ fontSize: 12.5 }}>Reviewer on Claude · uses the {project?.name} context and the linked specs.</span>
      </Card>
    );
  }
  if (isCurrentReview(review, p)) return null;

  const stale = review?.state === "succeeded";
  const failed = review?.state === "failed";
  return (
    <Card className="stack review-card">
      <b style={{ font: "600 16px var(--f-display)" }}>{stale ? "New commits since the agent review" : failed ? "The agent review failed" : "No agent review yet"}</b>
      {failed && review.error && <p className="fail">{review.error}</p>}
      <p className="sub" style={{ fontSize: 13 }}>
        {stale
          ? "The review below is of an earlier commit. Run it again to review what changed since."
          : "The reviewer reads the diff against the specs it touches, writes a walkthrough and lists findings. Refuters double-check each finding first, so you only see real ones."}
      </p>
      <div className="btns">
        <Button variant="primary" disabled={run.isPending} onClick={start}>
          {run.isPending ? "Starting…" : failed || stale ? "Run agent review again" : "Run agent review"}
        </Button>
      </div>
    </Card>
  );
}

const SEVERITY: Record<Finding["severity"], PillTone> = { high: "bad", medium: "warn", low: "idle" };

function Findings({ pull: p, review }: { pull: Pull; review: AgentReview | null | undefined }) {
  return (
    <div className="stack">
      <ReviewCard pull={p} review={review} />
      {review?.state === "succeeded" && <FindingList review={review} />}
    </div>
  );
}

function FindingList({ review }: { review: AgentReview }) {
  return (
    <>
      {review.findings.length === 0 ? (
        <Card><p className="sub">No findings. The reviewer and the refuters agree this PR does what its summary says.</p></Card>
      ) : (
        review.findings.map((f) => (
          <Card key={f.id} className={`stack finding f-${f.severity}`}>
            <div className="btns">
              <Pill tone={SEVERITY[f.severity]}>{f.severity}</Pill>
              {f.path && <code style={{ overflowWrap: "anywhere" }}>{f.path}{f.line ? `:${f.line}` : ""}</code>}
              {f.spec && <span className="id">{f.spec}</span>}
            </div>
            <b className="finding-title"><Inline>{f.title}</Inline></b>
            {f.body && <p><Inline>{f.body}</Inline></p>}
            {f.suggestedFix && (
              <div className="box">
                <span className="mh">suggested fix</span>
                <span><Inline>{f.suggestedFix}</Inline></span>
              </div>
            )}
          </Card>
        ))
      )}
      {review.dropped > 0 && (
        <p className="sub" style={{ fontSize: 12.5 }}>
          The refuters dropped {review.dropped} {review.dropped === 1 ? "finding" : "findings"} they could not confirm.
        </p>
      )}
    </>
  );
}

const IMPACT: Record<WalkStep["impact"], PillTone> = { high: "bad", medium: "warn", low: "idle" };
const RISK: Record<NonNullable<AgentReview["risk"]>, PillTone> = { high: "bad", medium: "warn", low: "ok" };

/** A diff excerpt, added lines green and removed lines red (the prototype's code block). */
function CodeLines({ code }: { code: string }) {
  return (
    <pre className="code">
      {code.split("\n").map((line, i) => (
        <span key={i} className={line.startsWith("+") ? "l-add" : line.startsWith("-") ? "l-del" : line.trim().startsWith("//") ? "l-com" : undefined}>
          {line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

/** Lockfiles and the like: long, machine-written, and rarely what a reviewer wants open. */
const GENERATED = /(^|\/)(Cargo\.lock|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|go\.sum|poetry\.lock|Gemfile\.lock|composer\.lock|uv\.lock|flake\.lock)$/;
/** A step opens its files' diffs only when it has at most this many. */
const OPEN_FILES_MAX = 3;

const stepId = (n: number) => `walk-step-${n}`;

/**
 * One numbered part of the change, in the order a reader takes it: title, spec and impact, what changed,
 * what it affects, then its files with the lines of their real diff that belong to this part. The header
 * folds the part away. The reviewer's excerpt is only shown for a file whose diff is not stored.
 */
function Step({ n, step, pull: p, diffs, shared, open, read, onToggle, onNext }: {
  n: number;
  step: WalkStep;
  pull: Pull;
  diffs: ReturnType<typeof usePullDiff>;
  /** Paths that more than one step names: their diff is narrowed to this step's lines. */
  shared: Set<string>;
  open: boolean;
  read: boolean;
  onToggle: () => void;
  onNext: (() => void) | null;
}) {
  const files = step.paths.map((path) => ({ path, file: p.files.find((f) => f.path === path) }));
  const unknown = files.filter((f) => !f.file).map((f) => f.path);
  const known = files.flatMap((f) => (f.file ? [f.file] : []));
  const added = known.reduce((s, f) => s + f.additions, 0);
  const removed = known.reduce((s, f) => s + f.deletions, 0);
  const bodyId = useId();
  return (
    <div className={`step walk-step${open ? "" : " folded"}`} id={stepId(n)}>
      <span className="n">{read ? "✓" : n}</span>
      <span className="stack-s" style={{ minWidth: 0 }}>
        <button type="button" className="walk-head" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
          <span className="btns" style={{ gap: 6 }}>
            <span aria-hidden="true" className="walk-caret">{open ? "▾" : "▸"}</span>
            <b className="walk-title"><Inline>{step.title}</Inline></b>
            {step.spec && <span className="id">{step.spec}</span>}
            <Pill tone={IMPACT[step.impact]}>{step.impact} impact</Pill>
            {!open && (
              <span className="mono sub" style={{ fontSize: 12 }}>
                {known.length} {known.length === 1 ? "file" : "files"} · <span style={{ color: "var(--ok)" }}>+{added}</span> <span style={{ color: "var(--bad)" }}>−{removed}</span>
              </span>
            )}
          </span>
        </button>
        {open && (
          <span id={bodyId} className="stack-s" style={{ minWidth: 0 }}>
            {step.change && <p className="walk-change"><Inline>{step.change}</Inline></p>}
            {step.effect && (
              <p className="walk-effect">
                <span className="lbl">Affects</span> <Inline>{step.effect}</Inline>
              </p>
            )}
            {files.map(({ path, file }) =>
              file ? (
                <FileRow
                  key={path}
                  file={file}
                  patch={diffs.data?.get(path)}
                  pending={diffs.isPending}
                  htmlUrl={p.htmlUrl}
                  defaultOpen={known.length <= OPEN_FILES_MAX && !GENERATED.test(path)}
                  ranges={step.lines.filter((r) => r.path === path)}
                  excerpt={shared.has(path) ? step.code : ""}
                />
              ) : null,
            )}
            {unknown.length > 0 && (
              <span className="btns" style={{ gap: 6 }}>
                {unknown.map((path) => <code key={path} style={{ overflowWrap: "anywhere" }}>{path}</code>)}
              </span>
            )}
            {(unknown.length > 0 || files.length === 0) && step.code.trim() && <CodeLines code={step.code} />}
            {onNext && (
              <span className="btns" style={{ justifyContent: "flex-end" }}>
                <Button small onClick={onNext}>Done, next part ↓</Button>
              </span>
            )}
          </span>
        )}
      </span>
    </div>
  );
}

const scrollToStep = (n: number) => document.getElementById(stepId(n))?.scrollIntoView?.({ behavior: "smooth", block: "start" });

/** The numbered parts with a contents list to jump between them and buttons to fold them all. */
function Steps({ steps, pull: p, diffs }: { steps: WalkStep[]; pull: Pull; diffs: ReturnType<typeof usePullDiff> }) {
  const [closed, setClosed] = useState<Set<number>>(() => new Set());
  const [read, setRead] = useState<Set<number>>(() => new Set());
  const shared = useMemo(() => {
    const seen = new Map<string, number>();
    for (const s of steps) for (const path of new Set(s.paths)) seen.set(path, (seen.get(path) ?? 0) + 1);
    return new Set([...seen].filter(([, k]) => k > 1).map(([path]) => path));
  }, [steps]);
  const toggle = (i: number) => setClosed((c) => { const next = new Set(c); if (next.has(i)) next.delete(i); else next.add(i); return next; });
  const jump = (i: number) => {
    setClosed((c) => { const next = new Set(c); next.delete(i); return next; });
    requestAnimationFrame(() => scrollToStep(i + 1));
  };
  const next = (i: number) => {
    setRead((r) => new Set(r).add(i));
    setClosed((c) => { const n = new Set(c).add(i); n.delete(i + 1); return n; });
    requestAnimationFrame(() => scrollToStep(i + 2));
  };
  return (
    <>
      <div className="walk-nav">
        <span className="btns" style={{ justifyContent: "space-between" }}>
          <span className="lbl">Walkthrough · {steps.length} {steps.length === 1 ? "part" : "parts"}{read.size > 0 ? ` · ${read.size} read` : ""}</span>
          <span className="btns" style={{ gap: 6 }}>
            <Button small variant="ghost" onClick={() => setClosed(new Set())}>Expand all</Button>
            <Button small variant="ghost" onClick={() => setClosed(new Set(steps.map((_, i) => i)))}>Collapse all</Button>
          </span>
        </span>
        {steps.length > 1 && (
          <ol className="walk-toc">
            {steps.map((s, i) => (
              <li key={`${i}-${s.title}`}>
                <button type="button" className={read.has(i) ? "done" : undefined} onClick={() => jump(i)}>
                  <span className="mono">{read.has(i) ? "✓" : i + 1}</span> <Inline>{s.title}</Inline>
                  <span className={`dot d-${s.impact}`} aria-label={`${s.impact} impact`} />
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
      {steps.map((step, i) => (
        <Step
          key={`${i}-${step.title}`}
          n={i + 1}
          step={step}
          pull={p}
          diffs={diffs}
          shared={shared}
          open={!closed.has(i)}
          read={read.has(i)}
          onToggle={() => toggle(i)}
          onNext={i < steps.length - 1 ? () => next(i) : null}
        />
      ))}
    </>
  );
}

function Walkthrough({ projectId, pull: p, review, gates, context, onFindings }: {
  projectId: string;
  pull: Pull;
  review: AgentReview | null | undefined;
  gates: Gate[];
  context: string;
  onFindings: () => void;
}) {
  const done = review?.state === "succeeded";
  const open = done ? review.findings.length : 0;
  const steps = done ? review.steps : [];
  const diffs = usePullDiff(projectId, p.id, steps.length > 0);
  const described = stripHtmlComments(p.body).trim() !== "";
  return (
    <div className="row">
      <div className="main stack">
        <ReviewCard pull={p} review={review} />
        <Card className="stack">
          <span className="lbl">What this PR does</span>
          {done && review.summary ? (
            <p className="walk-summary"><Inline>{review.summary}</Inline></p>
          ) : described ? (
            <Markdown fold>{p.body}</Markdown>
          ) : (
            <p className="sub">The author did not write a description.</p>
          )}
          {steps.length > 0 && <Steps steps={steps} pull={p} diffs={diffs} />}
          {diffs.error && <p className="err" role="alert">{diffs.error.message}</p>}
          {done && steps.length === 0 && review.walkthrough.trim() && (
            <>
              <span className="lbl">Walkthrough</span>
              <Markdown>{review.walkthrough}</Markdown>
            </>
          )}
          {done && review.decisions.map((q) => (
            <div key={q} className="btns needs-call">
              <Pill tone="warn">needs your call</Pill>
              <span style={{ fontSize: 13.5 }}><Inline>{q}</Inline></span>
            </div>
          ))}
          {open > 0 && (
            <div className="btns findings-banner">
              <span>{open} open {open === 1 ? "finding" : "findings"} from the reviewer.</span>
              <Button small onClick={onFindings}>See findings</Button>
            </div>
          )}
          {done && review.backend && (
            <span className="sub" style={{ fontSize: 12 }}>
              Reviewed with {BACKEND[review.backend]}{review.model ? ` · ${review.model}` : ""}.
            </span>
          )}
        </Card>
        {done && review.summary && described && (
          <Card className="stack">
            <span className="lbl">The author's description</span>
            <Markdown fold>{p.body}</Markdown>
          </Card>
        )}
      </div>
      <div className="aside stack">
        {done && review.risk && (
          <Card className="stack">
            <span className="lbl">Risk</span>
            <span className="btns"><Pill tone={RISK[review.risk]}>risk {review.risk.toUpperCase()}</Pill></span>
            {review.riskReason && <p style={{ fontSize: 13.5 }}><Inline>{review.riskReason}</Inline></p>}
          </Card>
        )}
        <Card className="stack">
          <span className="lbl">Gates</span>
          <div className="box">
            {gates.map((g) => (
              <span key={g.label} style={{ color: g.ok ? "var(--ok)" : "var(--fg)" }}>
                {g.ok ? "✓" : "○"} {g.label}
                {!g.checked && <span className="sub"> (not checked yet)</span>}
              </span>
            ))}
          </div>
        </Card>
        <Card className="stack">
          <span className="lbl">Project context the reviewer used</span>
          <p className="sub clamp" style={{ fontSize: 12.5 }}>{context.trim() || "No context yet."}</p>
          <Link to="/project" style={{ fontSize: 12.5 }}>Edit context</Link>
        </Card>
        <Card className="stack">
          <span className="lbl">Checks</span>
          {p.checks.length === 0 ? (
            <p className="sub" style={{ fontSize: 13 }}>{`No check runs for this commit yet. Pull from ${PROVIDER_NAME[hostOfUrl(p.htmlUrl)]} on the pull requests page to read them.`}</p>
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
          <a href={p.htmlUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12.5 }}>Open on {PROVIDER_NAME[hostOfUrl(p.htmlUrl)]}</a>
        </Card>
      </div>
    </div>
  );
}

type PullFile = Pull["files"][number];

/** One changed file: a header with its status and counts, and its diff when open. */
function FileRow({ file: f, patch, pending, htmlUrl, defaultOpen = false, ranges, excerpt }: {
  file: PullFile;
  patch: string | null | undefined;
  pending: boolean;
  htmlUrl: string;
  defaultOpen?: boolean;
  /** Narrow the diff to these new-file lines (a walkthrough step's own part of the file). */
  ranges?: Range[];
  /** Or to the hunks that quote this excerpt. */
  excerpt?: string;
}) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const id = useId();
  return (
    <div className="card file">
      <button className="file-head" type="button" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded((e) => !e)}>
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
          {pending ? (
            <p className="sub pad">Loading the changes…</p>
          ) : patch ? (
            <Diff patch={patch} ranges={ranges} excerpt={excerpt} />
          ) : (
            <p className="sub pad">
              No diff to show here: the file is binary, empty, or too large.{" "}
              <a href={`${htmlUrl}/${hostOfUrl(htmlUrl) === "gitlab" ? "diffs" : "files"}`} target="_blank" rel="noreferrer">View it on {PROVIDER_NAME[hostOfUrl(htmlUrl)]}</a>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Files({ projectId, pull: p }: { projectId: string; pull: Pull }) {
  const diffs = usePullDiff(projectId, p.id, true);
  if (p.files.length === 0) return <Card><p className="sub">No changed files are stored for this pull request yet.</p></Card>;
  return (
    <div className="stack">
      {diffs.error && <p className="err" role="alert">{diffs.error.message}</p>}
      {p.files.map((f) => <FileRow key={f.path} file={f} patch={diffs.data?.get(f.path)} pending={diffs.isPending} htmlUrl={p.htmlUrl} />)}
    </div>
  );
}

function Actions({ projectId, pull: p, gates }: { projectId: string; pull: Pull; gates: Gate[] }) {
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
  const openGates = gates.filter((g) => g.checked && !g.ok).length;

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
        <Button variant={p.state === "merged" ? "default" : "primary"} disabled={!open || p.draft || busy || openGates > 0} onClick={doMerge}>
          {p.state === "merged" ? "Merged" : merge.isPending ? "Merging…" : "Merge PR"}
        </Button>
      </div>
      <span className="sub" style={{ fontSize: 12, textAlign: "right", maxWidth: 340 }}>
        {p.state === "merged"
          ? "Merged just now"
          : p.state === "closed"
            ? "Closed without merging"
            : p.draft
              ? `Draft: mark it ready on ${PROVIDER_NAME[hostOfUrl(p.htmlUrl)]} to merge`
              : current === "changes_requested"
                ? "You asked for changes on this commit"
                : current === "approved"
                  ? "You approved this commit"
                  : openGates === 0
                    ? "All gates passed"
                    : `${openGates} ${openGates === 1 ? "gate" : "gates"} open`}
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
