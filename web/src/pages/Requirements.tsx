// Requirements drafted from a whiteboard and the discussion about it
// (requirements studio, phase 2). `/req` lists the project's sets; `/req/<id>`
// shows one: each flow's diagram, its steps and requirements with their
// stable ids, and the mockups, diagrams and notes that illustrate them.
import { useMemo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useCurrentProject, type Project } from "../api/queries";
import { useDeleteRequirementSet, useOpenRequirementsPull, useRequirementSet, useRequirementSets, type RequirementFlow, type RequirementSet, type RequirementView } from "../api/requirements";
import { useSpec, useSpecs } from "../api/specs";
import { Diagram } from "../spec/Diagram";
import { MermaidPreview } from "../spec/MermaidPreview";
import { mermaidOf, STATUS_LABEL, STATUS_TONE, stepsOf, type Step } from "../spec/model";
import { Button, Card, PageHead, Pill, Tabs } from "../ui/parts";
import { useToast } from "../ui/Toast";

const reqCount = (ids: string[]) => ids.filter((i) => i.includes("/")).length;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** `/req`: the project's requirements sets. */
export function RequirementsIndex() {
  const { project, isPending } = useCurrentProject();
  const sets = useRequirementSets(project?.id);
  if (isPending || sets.isPending) return <div className="page"><p className="sub">Loading…</p></div>;
  if (!project) return <Navigate to="/projects" replace />;
  return (
    <div className="page">
      <PageHead eyebrow="Requirements" title="Requirements" sub="Drafted from a whiteboard and your discussion with the coordinator. Every step and requirement has an id that the specs, code and tests share." />
      {sets.error ? (
        <Card>
          <p className="err">{sets.error.message}</p>
        </Card>
      ) : sets.data?.length ? (
        <div className="stack">
          {sets.data.map((s) => (
            <Link key={s.id} className="card pr-row" to={`/req/${s.id}`}>
              <div className="stack-s" style={{ gap: 4, minWidth: 0 }}>
                <b style={{ font: "600 15px var(--f-display)" }}>{s.title}</b>
                <span className="meta">
                  {plural(s.flows, "flow", "flows")} · {plural(s.requirements, "requirement", "requirements")} · changed {new Date(s.updatedAt).toLocaleString()}
                </span>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <Card>
          <p className="sub">
            No requirements yet. Talk an idea through with the coordinator on a <Link to="/board">whiteboard</Link>, then draft requirements from it.
          </p>
        </Card>
      )}
    </div>
  );
}

/** One view: a screen mockup, a diagram or a note. */
function ViewCard({ v }: { v: RequirementView }) {
  const label = { mockup: "Mockup", diagram: "Diagram", note: "Note" }[v.kind];
  return (
    <figure className={`rq-view rq-${v.kind}`} aria-label={`${label}: ${v.title}`}>
      <figcaption>
        <span className="lbl">{label}</span> <b>{v.title}</b>
        {v.of && <span className="id">{v.of}</span>}
      </figcaption>
      {v.kind === "diagram" ? (
        <MermaidPreview text={v.text} label={v.title} />
      ) : v.kind === "mockup" ? (
        <div className="rq-screen">
          <div className="rq-bar" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <div className="md">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{v.text}</ReactMarkdown>
          </div>
        </div>
      ) : (
        <div className="md">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{v.text}</ReactMarkdown>
        </div>
      )}
    </figure>
  );
}

function Views({ views }: { views: RequirementView[] }) {
  if (!views.length) return null;
  return (
    <div className="rq-views">
      {views.map((v) => (
        <ViewCard key={v.id} v={v} />
      ))}
    </div>
  );
}

function StepCard({ step, views, on }: { step: Step; views: RequirementView[]; on: boolean }) {
  const mine = views.filter((v) => v.of === step.id || v.of?.startsWith(`${step.id}/`));
  return (
    <section id={`step-${step.id}`} className={on ? "card pad stack rq-step on" : "card pad stack rq-step"} aria-label={`Step ${step.title}`}>
      <div className="btns" style={{ justifyContent: "space-between" }}>
        <b style={{ font: "600 15px var(--f-display)" }}>{step.title}</b>
        <span className="id">{step.id}</span>
      </div>
      {step.reqs.length ? (
        <ul className="rq-list">
          {step.reqs.map((r) => (
            <li key={r.id}>
              <span className="id">{r.id}</span>
              <span>
                <b>WHEN</b> {r.condition} <b>THE SYSTEM SHALL</b> {r.response}.
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="sub">No requirements on this step yet.</p>
      )}
      {step.flow && <blockquote className="rq-why">{step.flow}</blockquote>}
      <Views views={mine} />
    </section>
  );
}

function FlowSection({ flow, views, selected, onSelect }: { flow: RequirementFlow; views: RequirementView[]; selected: string | null; onSelect: (stepId: string) => void }) {
  const steps = useMemo(() => stepsOf({ model: flow.model, anchors: [] }), [flow.model]);
  const mermaid = mermaidOf(flow.source);
  const errors = flow.diagnostics.filter((d) => d.code.startsWith("S"));
  const node = steps.find((s) => s.id === selected)?.node ?? null;
  return (
    <section className="stack" aria-label={`Flow ${flow.title}`}>
      <div className="btns">
        <h2 style={{ font: "600 18px var(--f-display)", margin: 0 }}>{flow.title}</h2>
        <span className="id">{flow.flow}</span>
        <span className="mono sub" style={{ fontSize: 12 }}>{flow.path}</span>
        {errors.length > 0 && <Pill tone="bad">{plural(errors.length, "error", "errors")}</Pill>}
      </div>
      {errors.length > 0 && (
        <Card>
          <p className="err">This flow does not parse yet, so its ids are not issued:</p>
          <ul className="mono" style={{ fontSize: 12.5 }}>
            {errors.map((d, i) => (
              <li key={i}>
                line {d.line}: {d.code} {d.message}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {mermaid && (
        <Card>
          <Diagram source={mermaid} label={`${flow.title} flow`} selected={node} onSelect={(n) => onSelect(`${flow.flow}.${n}`)} />
        </Card>
      )}
      {steps.map((s) => (
        <StepCard key={s.id} step={s} views={views} on={s.id === selected} />
      ))}
    </section>
  );
}

const TABS = [
  { id: "req", label: "Requirements" },
  { id: "code", label: "Code + tests" },
  { id: "files", label: "Spec files" },
];

/** A Rust function name from a requirement: `pay_r2_show_the_reason`. */
const fnName = (node: string, tag: string, response: string) =>
  `${node}_${tag}_${response.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").split("_").slice(0, 5).join("_")}`.slice(0, 60);

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      small
      variant="ghost"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          window.setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? "Copied" : "Copy"}
    </Button>
  );
}

/** How code and tests point at a flow's ids, and, once the spec is in a repo and indexed, which ids they already cover. */
function FlowCode({ project, flow }: { project: Project; flow: RequirementFlow }) {
  const specs = useSpecs(project.id).data ?? [];
  const indexed = specs.find((s) => s.flow === flow.flow);
  const spec = useSpec(project.id, indexed?.id).data ?? null;
  const steps = useMemo(() => stepsOf(spec ? { model: spec.model, anchors: spec.anchors } : { model: flow.model, anchors: [] }), [spec, flow.model]);
  return (
    <section className="stack" aria-label={`Code and tests for ${flow.title}`}>
      <div className="btns">
        <h2 style={{ font: "600 18px var(--f-display)", margin: 0 }}>{flow.title}</h2>
        <span className="id">{flow.flow}</span>
        {indexed ? (
          <Link to={`/spec/${indexed.id}?tab=code`}>
            In {indexed.repo}: {indexed.tested}/{indexed.requirements} tested
          </Link>
        ) : (
          <span className="sub" style={{ fontSize: 12.5 }}>Not in a repo yet: tested status shows once the spec is merged and indexed.</span>
        )}
      </div>
      {steps.map((s) => {
        const impl = `#[spec("${s.id}")]\npub fn ${s.node}() {\n    // ${s.title}\n}`;
        return (
          <Card key={s.id}>
            <div className="stack">
              <div className="btns" style={{ justifyContent: "space-between" }}>
                <b>{s.title}</b>
                <span className="btns" style={{ gap: 6 }}>
                  <span className="id">{s.id}</span>
                  {spec && <Pill tone={STATUS_TONE[s.status]}>{STATUS_LABEL[s.status]}</Pill>}
                </span>
              </div>
              {s.code.length > 0 ? (
                <span className="mono sub" style={{ fontSize: 12 }}>Code: {s.code.map((a) => `${a.path}:${a.line}`).join(", ")}</span>
              ) : (
                <div className="rq-snippet">
                  <span className="lbl">Implement the step</span>
                  <pre>{impl}</pre>
                  <Copy text={impl} label={`Copy the anchor for ${s.id}`} />
                </div>
              )}
              {s.reqs.map((r) => {
                const test = `#[test]\n#[spec("${r.id}")]\nfn ${fnName(s.node, r.tag, r.response)}() {\n    // WHEN ${r.condition} THE SYSTEM SHALL ${r.response}.\n    todo!()\n}`;
                const tests = s.tests.filter((t) => t.target === r.id || t.target === s.id);
                return (
                  <div key={r.id} className="rq-snippet">
                    <div className="btns">
                      <span className="id">{r.id}</span>
                      {spec && <Pill tone={r.tested ? "ok" : "idle"}>{r.tested ? "tested" : "no tests"}</Pill>}
                    </div>
                    {tests.length > 0 ? (
                      <span className="mono sub" style={{ fontSize: 12 }}>Tests: {tests.map((a) => `${a.path}:${a.line}`).join(", ")}</span>
                    ) : (
                      <>
                        <pre>{test}</pre>
                        <Copy text={test} label={`Copy a test for ${r.id}`} />
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        );
      })}
    </section>
  );
}

/** Add the spec files to a repo as a pull request, or show the one that did. */
function AddToRepo({ project, set }: { project: Project; set: RequirementSet }) {
  const open = useOpenRequirementsPull(project.id, set.id);
  const toast = useToast();
  const [repoId, setRepoId] = useState(project.repos[0]?.id ?? "");
  if (set.pull)
    return (
      <Card>
        <p style={{ margin: 0 }}>
          Added to {set.pull.repo} in{" "}
          <a href={set.pull.url} target="_blank" rel="noreferrer">
            pull request #{set.pull.number}
          </a>
          . Once it is merged and indexed, Code + tests shows which ids are covered.
        </p>
      </Card>
    );
  const broken = set.flows.filter((f) => !f.model).length;
  return (
    <section className="card pad btns" aria-label="Add to a repo">
      <span className="sub" style={{ flex: "1 1 260px" }}>
        Add the spec files ({set.flows.map((f) => f.path).join(", ")}) and their views to a repo as a pull request. The ids stay the same.
      </span>
      {project.repos.length > 1 && (
        <select aria-label="Repo" value={repoId} onChange={(e) => setRepoId(e.target.value)} className="rq-select">
          {project.repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.full_name}
            </option>
          ))}
        </select>
      )}
      <Button
        variant="primary"
        small
        disabled={!repoId || broken > 0 || open.isPending}
        onClick={() => open.mutate(repoId, { onSuccess: (s) => toast(`Opened pull request #${s.pull?.number ?? ""}.`), onError: (e) => toast(e.message) })}
      >
        {open.isPending ? "Opening…" : project.repos.length === 1 ? `Open a pull request in ${project.repos[0]!.full_name}` : "Open a pull request"}
      </Button>
      {!project.repos.length && <p className="err">Add a repo to the project first.</p>}
      {broken > 0 && <p className="err">Fix the flows with errors first; ask the coordinator.</p>}
    </section>
  );
}

function SetView({ set, project, children }: { set: RequirementSet; project: Project; children: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "files" ? "files" : params.get("tab") === "code" ? "code" : "req";
  const selected = params.get("step");
  const select = (id: string) => {
    setParams((p) => {
      p.set("step", id);
      return p;
    }, { replace: true });
    document.getElementById(`step-${id}`)?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  };
  const flowIds = new Set(set.flows.map((f) => f.flow));
  const loose = set.views.filter((v) => !v.of || flowIds.has(v.of) || !set.ids.includes(v.of));
  return (
    <div className="page">
      {children}
      <AddToRepo project={project} set={set} />
      <Tabs
        items={TABS}
        value={tab}
        onChange={(id) =>
          setParams((p) => {
            p.set("tab", id);
            return p;
          })
        }
      />
      {tab === "req" ? (
        <>
          {set.flows.map((f) => (
            <FlowSection key={f.flow} flow={f} views={set.views} selected={selected} onSelect={select} />
          ))}
          {loose.length > 0 && (
            <section className="stack" aria-label="Also discussed">
              <h2 style={{ font: "600 18px var(--f-display)", margin: 0 }}>Also discussed</h2>
              <Views views={loose} />
            </section>
          )}
        </>
      ) : tab === "code" ? (
        set.flows.map((f) => <FlowCode key={f.flow} project={project} flow={f} />)
      ) : (
        set.flows.map((f) => (
          <Card key={f.flow}>
            <span className="lbl">{f.path}</span>
            <pre className="rq-source" aria-label={`Spec file ${f.path}`}>
              {f.source}
            </pre>
          </Card>
        ))
      )}
    </div>
  );
}

/** `/req/:setId`: one requirements set. */
export function RequirementsPage() {
  const { setId } = useParams();
  const { project, isPending } = useCurrentProject();
  const query = useRequirementSet(project?.id, setId);
  const remove = useDeleteRequirementSet(project?.id ?? "");
  const navigate = useNavigate();
  const toast = useToast();
  if (isPending || query.isPending) return <div className="page"><p className="sub">Loading…</p></div>;
  if (!project) return <Navigate to="/projects" replace />;
  if (query.error) return <div className="page"><Card><p className="err">{query.error.message}</p></Card></div>;
  const set = query.data;
  if (!set) return <Navigate to="/req" replace />;
  return (
    <SetView set={set} project={project}>
      <PageHead
        eyebrow="Requirements"
        title={set.title}
        sub={`${plural(set.flows.length, "flow", "flows")}, ${plural(reqCount(set.ids), "requirement", "requirements")}, ${plural(set.views.length, "view", "views")}. Every id stays the same from here to the specs, code and tests.`}
      >
        {set.boardId && (
          <Link className="btn sm" style={{ textDecoration: "none" }} to={`/board/${set.boardId}`}>
            Back to the board
          </Link>
        )}
        <Button
          small
          disabled={remove.isPending}
          onClick={() =>
            remove.mutate(set.id, {
              onSuccess: () => {
                toast("Requirements deleted.");
                navigate("/req");
              },
              onError: (e) => toast(e.message),
            })
          }
        >
          Delete
        </Button>
      </PageHead>
    </SetView>
  );
}
