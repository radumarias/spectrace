// The spec page (T4.5), as in the prototype's `#spec`: the flow's diagram, the
// spec as Markdown, and the code and tests anchored to it, with an inspector
// for the selected step. `/spec` opens the project's spec (or lists them when
// there are several); `/spec/<id>?step=<node>&tab=<tab>` keeps the selection in
// the address.
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { useCurrentProject } from "../api/queries";
import { useSaveSpec, useSpec, useSpecs, type SpecAnchor, type SpecDetail, type SpecSummary } from "../api/specs";
import { Button, Card, Pill, Tabs } from "../ui/parts";
import { Diagram } from "../spec/Diagram";
import { SpecMarkdown } from "../spec/SpecMarkdown";
import { githubLine, itemName, mermaidOf, STATUS_LABEL, STATUS_TONE, stepsOf, type Step, type StepStatus } from "../spec/model";

// The editor loads spectrace-core (WASM) only when someone edits.
const SpecEditor = lazy(() => import("../spec/SpecEditor").then((m) => ({ default: m.SpecEditor })));

const TABS = [
  { id: "diagram", label: "Diagram" },
  { id: "md", label: "Markdown" },
  { id: "code", label: "Code + tests" },
];

const DOT: Record<StepStatus, string> = { ok: "var(--ok)", warn: "var(--warn)", idle: "var(--idle)" };

function Legend() {
  return (
    <div className="legend">
      {(["ok", "warn", "idle"] as StepStatus[]).map((s) => (
        <span key={s}>
          <span className="dot" style={{ background: DOT[s] }} />
          {STATUS_LABEL[s]}
        </span>
      ))}
    </div>
  );
}

/** One line of the project's specs, for the list when there are several. */
function SpecRow({ s }: { s: SpecSummary }) {
  return (
    <Link className="card pr-row" to={`/spec/${s.id}`}>
      <div className="stack-s" style={{ gap: 4, minWidth: 0 }}>
        <b style={{ font: "600 15px var(--f-display)" }}>{s.title}</b>
        <span className="meta">
          {s.repo} · {s.path}
        </span>
      </div>
      <div className="btns">
        {s.errors > 0 ? <Pill tone="bad">{s.errors === 1 ? "1 error" : `${s.errors} errors`}</Pill> : null}
        <Pill tone={s.requirements > 0 && s.tested === s.requirements ? "ok" : s.tested > 0 ? "warn" : "idle"}>
          {s.tested}/{s.requirements} tested
        </Pill>
      </div>
    </Link>
  );
}

/** `/spec`: straight to the spec when the project has one, else the list. */
export function SpecIndex() {
  const { project, isPending } = useCurrentProject();
  const specs = useSpecs(project?.id);
  if (isPending || specs.isPending) return <div className="page"><p className="sub">Loading…</p></div>;
  if (!project) return <Navigate to="/projects" replace />;
  if (specs.error) return <div className="page"><Card><p className="err">{specs.error.message}</p></Card></div>;
  const list = specs.data ?? [];
  if (list.length === 1) return <Navigate to={`/spec/${list[0]!.id}`} replace />;
  const indexing = project.repos.some((r) => r.index_state === "pending" || r.index_state === "indexing");
  return (
    <div className="page">
      <div className="head">
        <div>
          <span className="eyebrow">Spec</span>
          <h1>Specs</h1>
          <p className="sub">One file per flow, in a spec/ folder of a repo.</p>
        </div>
      </div>
      {list.length === 0 ? (
        <Card>
          <p className="sub">
            {indexing ? "The repos are being indexed. Specs show up here when it finishes." : "No specs yet. Add spec/<flow>.md to a repo of this project, as in docs/spec-format.md."}
          </p>
        </Card>
      ) : (
        <div className="stack">{list.map((s) => <SpecRow key={s.id} s={s} />)}</div>
      )}
    </div>
  );
}

/** Lines of an excerpt with the prototype's code colours: attributes, comments. */
function CodeBlock({ text, start }: { text: string; start?: number }) {
  const lines = text.split("\n");
  return (
    <pre className="code" data-start={start}>
      {lines.map((l, i) => {
        const t = l.trim();
        const cls = t.startsWith("#[") ? "l-attr" : t.startsWith("//") || t.startsWith("#") ? "l-com" : undefined;
        return (
          <span key={i} className={cls}>
            {l}
            {i < lines.length - 1 ? "\n" : ""}
          </span>
        );
      })}
    </pre>
  );
}

function AnchorBlock({ spec, a }: { spec: SpecDetail; a: SpecAnchor }) {
  return (
    <div className="stack-s">
      <div className="btns" style={{ justifyContent: "space-between" }}>
        <a className="lbl" href={githubLine(spec, a.path, a.line)} target="_blank" rel="noreferrer noopener" style={{ textDecoration: "none" }}>
          {a.path}:{a.line}
          {itemName(a.excerpt) ? ` · ${itemName(a.excerpt)}` : ""}
        </a>
        <Pill tone="acc">anchored to {a.target}</Pill>
      </div>
      <CodeBlock text={a.excerpt} start={a.line} />
    </div>
  );
}

function CodeTab({ spec, step }: { spec: SpecDetail; step: Step }) {
  return (
    <>
      {step.code.length ? (
        step.code.map((a) => <AnchorBlock key={`${a.path}:${a.line}`} spec={spec} a={a} />)
      ) : (
        <p className="sub">No code is anchored to {step.id} yet. Add #[spec("{step.id}")] to the function that does it.</p>
      )}
      <span className="lbl">tests</span>
      {step.tests.length ? (
        step.tests.map((a) => <AnchorBlock key={`${a.path}:${a.line}`} spec={spec} a={a} />)
      ) : (
        <CodeBlock text={`// no tests yet: add #[spec("${step.id}/r1")] to a test of ${step.id}`} />
      )}
    </>
  );
}

function Inspector({ spec, step, onTab }: { spec: SpecDetail; step: Step; onTab: (t: string) => void }) {
  const tested = step.reqs.filter((r) => r.tested).length;
  const code = step.code[0];
  return (
    <aside className="aside card pad stack" aria-label="Inspector">
      <div className="btns" style={{ justifyContent: "space-between" }}>
        <span className="lbl">Inspector</span>
        <Pill tone={STATUS_TONE[step.status]}>{STATUS_LABEL[step.status]}</Pill>
      </div>
      <h2 style={{ fontSize: 20 }}>{step.title}</h2>
      <span className="id" style={{ alignSelf: "flex-start" }}>
        {step.id}
      </span>
      <dl className="kv">
        <dt>Code</dt>
        <dd>
          {code ? (
            <>
              {itemName(code.excerpt) && <><code>{itemName(code.excerpt)}</code> · </>}
              <code>{code.path}</code>
            </>
          ) : (
            <span className="sub">not anchored</span>
          )}
        </dd>
        <dt>Coverage</dt>
        <dd>
          req {tested}/{step.reqs.length}
        </dd>
      </dl>
      <div className="box">
        <span className="mh">requirements</span>
        {step.reqs.length ? (
          step.reqs.map((r) => (
            <div key={r.tag} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12.5 }}>
              <span className="dot" style={{ background: r.tested ? "var(--ok)" : "var(--idle)", marginTop: 6 }} />
              <span>
                <span className="mono sub">{r.tag}</span> WHEN {r.condition}, {r.response}
              </span>
            </div>
          ))
        ) : (
          <span className="sub">No requirement lines yet.</span>
        )}
      </div>
      <div className="stack-s">
        <span className="mono" style={{ color: "var(--accent)", fontSize: 11, fontWeight: 600 }}>
          tests
        </span>
        {step.tests.length ? (
          step.tests.map((t) => (
            <span key={`${t.path}:${t.line}`} className="mono" style={{ fontSize: 12 }}>
              {itemName(t.excerpt) ?? t.path} <span className="sub">→ {t.target.slice(step.id.length + 1) || "all"}</span>
            </span>
          ))
        ) : (
          <span className="sub" style={{ fontSize: 12.5 }}>
            No tests yet.
          </span>
        )}
      </div>
      {step.flow && (
        <div className="md-flow">
          <span className="mono">flow · {step.id}</span>
          {step.flow}
        </div>
      )}
      <div className="btns">
        <Button small onClick={() => onTab("code")}>
          Open code
        </Button>
        <a className="btn sm" href={githubLine(spec, spec.path, step.line)} target="_blank" rel="noreferrer noopener" style={{ textDecoration: "none" }}>
          Open on GitHub
        </a>
      </div>
    </aside>
  );
}

/** The diagram on its own screen, as in the prototype: Esc or Exit closes it, tall screens draw it top to bottom. */
function FullScreen({
  title,
  onClose,
  foot,
  children,
}: {
  title: string;
  onClose: () => void;
  foot: ReactNode;
  children: (vertical: boolean, zoomSlot: HTMLElement | null) => ReactNode;
}) {
  const [vertical, setVertical] = useState(() => window.innerHeight > window.innerWidth * 1.15);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onResize = () => setVertical(window.innerHeight > window.innerWidth * 1.15);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [onClose]);
  return (
    <div className="fs" role="dialog" aria-modal="true" aria-labelledby="fs-title">
      <div className="fs-bar">
        <button type="button" className="btn sm fs-x" onClick={onClose} aria-label="Exit full screen">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
          <span className="fs-xl">
            Exit <span className="mono sub">Esc</span>
          </span>
        </button>
        <h2 id="fs-title">{title}</h2>
        <div ref={setSlot} />
      </div>
      <div className="fs-body">{children(vertical, slot)}</div>
      <div className="fs-foot">
        <div className="fs-sum" aria-live="polite">{foot}</div>
        <div className="fs-extra">
          <span className="sub" style={{ fontSize: 12 }}>
            Scroll or pinch to zoom · drag to move
          </span>
          <Legend />
        </div>
      </div>
    </div>
  );
}

const FS_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </svg>
);

export function SpecPage() {
  const { specId } = useParams();
  const [params, setParams] = useSearchParams();
  const { project, isPending } = useCurrentProject();
  const query = useSpec(project?.id, specId);
  const [fs, setFs] = useState(false);
  const closeFs = useCallback(() => setFs(false), []);
  const saveSpec = useSaveSpec(project?.id ?? "", specId ?? "");
  const spec = query.data;
  const steps = useMemo(() => (spec ? stepsOf(spec) : []), [spec]);
  const status = useMemo(() => Object.fromEntries(steps.map((s) => [s.node, s.status])), [steps]);
  const tab = TABS.some((t) => t.id === params.get("tab")) ? params.get("tab")! : "diagram";
  const want = params.get("step");
  const step = steps.find((s) => s.node === want) ?? steps.find((s) => s.status !== "ok") ?? steps[0];

  const set = (k: "tab" | "step" | "md" | "edit", v: string | null) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (v === null) n.delete(k);
        else n.set(k, v);
        return n;
      },
      { replace: true },
    );
  const select = (node: string) => set("step", node);

  if (isPending || query.isPending) return <div className="page"><p className="sub">Loading…</p></div>;
  if (!project) return <Navigate to="/projects" replace />;
  if (query.error) return <div className="page"><Card><p className="err">{query.error.message}</p></Card></div>;
  if (!spec) return <Navigate to="/spec" replace />;

  const mermaid = mermaidOf(spec.source);
  const crumbs = [spec.repo, spec.area, spec.path].filter(Boolean).join(" / ");
  const tested = steps.reduce((n, s) => n + s.reqs.filter((r) => r.tested).length, 0);
  const total = steps.reduce((n, s) => n + s.reqs.length, 0);
  const flowTitle = `${spec.title} flow`;

  let body: ReactNode;
  if (!spec.model) {
    body = (
      <div className="stack" role="alert">
        <span className="lbl">This spec has errors and is not used until they are fixed</span>
        <ul className="diags">
          {spec.diagnostics.map((d, i) => (
            <li key={i}>
              <a className="mono" href={githubLine(spec, spec.path, d.line)} target="_blank" rel="noreferrer noopener">
                {d.code} line {d.line}
              </a>{" "}
              {d.message}
            </li>
          ))}
        </ul>
        <CodeBlock text={spec.source} />
      </div>
    );
  } else if (tab === "md") {
    // devpage server renders the spec when it runs here; the requirement view is spectrace's own, with test status and step selection.
    const page = spec.devpage && params.get("md") !== "status" ? spec.devpage : null;
    body = (
      <>
        <div className="btns" style={{ justifyContent: "space-between" }}>
          <span className="lbl">
            {spec.path} · {page ? `rendered by devpage · version ${page.version}` : spec.devpage ? "requirement status" : "rendered by spectrace, devpage is off here"}
          </span>
          {spec.devpage && (
            <div className="seg" role="group" aria-label="Markdown view">
              <button type="button" className={page ? "on" : ""} aria-pressed={!!page} onClick={() => set("md", null)}>
                devpage
              </button>
              <button type="button" className={page ? "" : "on"} aria-pressed={!page} onClick={() => set("md", "status")}>
                Requirement status
              </button>
            </div>
          )}
        </div>
        {page ? (
          <iframe className="devpage-frame" src={page.url} title={`${spec.title} spec, rendered by devpage`} />
        ) : (
          <SpecMarkdown source={spec.source} steps={steps} selected={step?.node ?? null} onSelect={select} status={status} />
        )}
      </>
    );
  } else if (tab === "code" && step) {
    body = <CodeTab spec={spec} step={step} />;
  } else {
    body = (
      <>
        <div className="btns" style={{ justifyContent: "space-between" }}>
          <span className="lbl">
            {spec.flow} · {tested}/{total} requirements tested
          </span>
          {mermaid && (
            <Button small variant="primary" onClick={() => set("edit", "1")}>
              Edit diagram
            </Button>
          )}
        </div>
        {mermaid ? (
          <div className="dia-wrap">
            <Diagram
              source={mermaid}
              label={flowTitle}
              status={status}
              selected={step?.node}
              onSelect={select}
              tools={(zoom) => (
                <div className="dia-tools">
                  {zoom}
                  <Button small className="fs-btn" onClick={() => setFs(true)} aria-label={`Show ${flowTitle} full screen`}>
                    {FS_ICON}Full screen
                  </Button>
                </div>
              )}
            />
          </div>
        ) : null}
        <Legend />
      </>
    );
  }

  if (params.get("edit") && spec.model && mermaid) {
    return (
      <div className="page">
        <div className="head">
          <div>
            <span className="mono sub" style={{ fontSize: 12, overflowWrap: "anywhere" }}>
              {crumbs}
            </span>
            <h1>
              {spec.title} <Pill tone="acc">editing</Pill>
            </h1>
          </div>
        </div>
        <Suspense fallback={<p className="sub">Loading the editor…</p>}>
          <SpecEditor key={spec.source} spec={{ path: spec.path, title: spec.title, flow: spec.flow, source: spec.source, status }} onSave={(body) => saveSpec.mutateAsync(body)} onClose={() => set("edit", null)} />
        </Suspense>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="head">
        <div>
          <span className="mono sub" style={{ fontSize: 12, overflowWrap: "anywhere" }}>
            {crumbs}
          </span>
          <h1>{spec.title}</h1>
        </div>
      </div>
      <Tabs items={TABS} value={tab} onChange={(t) => set("tab", t)} />
      <div className="row">
        <div className="main card pad stack">{body}</div>
        {step ? <Inspector spec={spec} step={step} onTab={(t) => set("tab", t)} /> : null}
      </div>
      {fs && mermaid && (
        <FullScreen
          title={flowTitle}
          onClose={closeFs}
          foot={
            step && (
              <>
                <b>{step.title}</b>
                <span className="id">{step.id}</span>
                <Pill tone={STATUS_TONE[step.status]}>{STATUS_LABEL[step.status]}</Pill>
                <span className="sub">
                  req {step.reqs.filter((r) => r.tested).length}/{step.reqs.length}
                </span>
              </>
            )
          }
        >
          {(vertical, slot) => (
            <Diagram
              key={vertical ? "v" : "h"}
              source={mermaid}
              label={flowTitle}
              status={status}
              selected={step?.node}
              onSelect={select}
              fill
              vertical={vertical}
              tools={(zoom) => (slot ? createPortal(zoom, slot) : null)}
            />
          )}
        </FullScreen>
      )}
    </div>
  );
}
