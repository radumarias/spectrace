// Requirements drafted from a whiteboard and the discussion about it
// (requirements studio, phase 2). `/req` lists the project's sets; `/req/<id>`
// shows one: each flow's diagram, its steps and requirements with their
// stable ids, and the mockups, diagrams and notes that illustrate them.
import { useMemo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useCurrentProject } from "../api/queries";
import { useDeleteRequirementSet, useRequirementSet, useRequirementSets, type RequirementFlow, type RequirementSet, type RequirementView } from "../api/requirements";
import { Diagram } from "../spec/Diagram";
import { MermaidPreview } from "../spec/MermaidPreview";
import { mermaidOf, stepsOf, type Step } from "../spec/model";
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
  { id: "files", label: "Spec files" },
];

function SetView({ set, children }: { set: RequirementSet; children: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "files" ? "files" : "req";
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
    <SetView set={set}>
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
