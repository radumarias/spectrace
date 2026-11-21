// The diagram editor (T5.2), as in the prototype's `#spec` edit mode: add,
// rename and delete steps, add, relabel and delete arrows, edit requirement
// lines, undo, and a change summary before saving. Every edit goes through
// spectrace-core (`editSpec`, the core writer in WASM), so the file changes
// only where the edit is, and saving opens a pull request with that file.
// Steps are laid out by pele, not by hand: the spec format has no positions.
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { useSaveSpec, type SpecChangeOpened, type SpecDetail } from "../api/specs";
import { Button, Pill } from "../ui/parts";
import { useToast } from "../ui/Toast";
import { editSpec, loadCore, parseSpec, type ParsedSpec, type SpecEdit } from "./core";
import { Diagram } from "./Diagram";
import { diffLines, hunks } from "./diff";
import { mermaidOf, stepsOf } from "./model";

type Applied = { source: string; summary: string };
type Spec = ParsedSpec["spec"];

/** What the editor shows of a spec: steps in diagram order, with their sections. */
function view(spec: Spec) {
  const d = spec.diagram;
  const nodes = d?.nodes ?? [];
  const sections = new Map(spec.sections.map((s) => [s.node, s]));
  return { nodes, edges: d?.edges ?? [], sections };
}

/** A text field that reports its value when it loses focus or on Enter, and only if it changed. */
function Field({ value, label, onCommit, mono }: { value: string; label: string; onCommit: (v: string) => void; mono?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => {
    const t = v.trim();
    if (t && t !== value) onCommit(t);
    else setV(value);
  };
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
    if (e.key === "Escape") {
      setV(value);
      e.currentTarget.blur();
    }
  };
  return <input aria-label={label} value={v} autoComplete="off" className={mono ? "mono" : undefined} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={key} />;
}

export function SpecEditor({ spec, projectId, onClose }: { spec: SpecDetail; projectId: string; onClose: () => void }) {
  const toast = useToast();
  const save = useSaveSpec(projectId, spec.id);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [applied, setApplied] = useState<Applied[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [from, setFrom] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [opened, setOpened] = useState<SpecChangeOpened | null>(null);

  useEffect(() => {
    loadCore().then(
      () => setReady(true),
      (e: unknown) => setFailed(e instanceof Error ? e.message : String(e)),
    );
  }, []);

  const source = applied.length ? applied[applied.length - 1]!.source : spec.source;
  const parsed = useMemo(() => (ready ? parseSpec(spec.path, source).spec : null), [ready, spec.path, source]);
  const base = useMemo(() => (ready ? view(parseSpec(spec.path, spec.source).spec) : null), [ready, spec.path, spec.source]);
  const now = useMemo(() => (parsed ? view(parsed) : null), [parsed]);
  const flow = parsed?.flow ?? spec.flow;
  const selected = sel && now?.nodes.some((n) => n.id === sel) ? sel : (now?.nodes[0]?.id ?? null);

  const status = useMemo(() => {
    const out: Record<string, "ok" | "warn" | "idle" | "new"> = Object.fromEntries(stepsOf(spec).map((s) => [s.node, s.status]));
    if (!now || !base) return out;
    for (const n of now.nodes) {
      const was = base.nodes.find((b) => b.id === n.id);
      const reqs = (node: string, v: typeof now) => JSON.stringify(v.sections.get(node)?.requirements.map((r) => [r.tag, r.condition, r.response]) ?? []);
      if (!was || was.label !== n.label || reqs(n.id, now) !== reqs(n.id, base)) out[n.id] = "new";
    }
    return out;
  }, [spec, now, base]);

  const diff = useMemo(() => hunks(diffLines(spec.source, source)), [spec.source, source]);
  const changes = applied.length;

  const apply = (op: SpecEdit, summary: string, select?: string | null) => {
    try {
      const next = editSpec(spec.path, source, op);
      setApplied((a) => [...a, { source: next, summary }]);
      if (select !== undefined) setSel(select);
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
      return false;
    }
  };
  const label = (id: string) => now?.nodes.find((n) => n.id === id)?.label ?? id;

  const pick = (node: string) => {
    if (from) {
      if (from !== node && apply({ op: "addEdge", from, label: "next", to: node }, `Added an arrow from ${label(from)} to ${label(node)}`, from)) {
        toast("Arrow added. Rename it in the inspector.");
      }
      setFrom(null);
      return;
    }
    setSel(node);
  };
  const addStep = () => {
    if (!now) return;
    let n = 1;
    while (now.nodes.some((x) => x.id === `step_${n}`)) n++;
    const node = `step_${n}`;
    apply({ op: "addStep", node, label: "New step", from: selected, edgeLabel: selected ? "next" : null }, selected ? `Added the step New step after ${label(selected)}` : "Added the step New step", node);
    window.setTimeout(() => document.querySelector<HTMLInputElement>('input[aria-label="Label on the diagram"]')?.select(), 60);
  };
  const undo = () => {
    if (!applied.length) return toast("Nothing to undo.");
    setApplied((a) => a.slice(0, -1));
    setFrom(null);
  };
  const submit = () =>
    save.mutate(
      { source, summary: applied.map((a) => a.summary) },
      {
        onSuccess: (pr) => {
          setOpened(pr);
          setConfirm(false);
          toast(`Saved to ${spec.path}. Pull request #${pr.number} is open for review.`);
        },
        onError: (e) => toast(e.message),
      },
    );

  if (failed) return <p className="err">The editor could not load spectrace-core: {failed}</p>;
  if (!now || !parsed) return <p className="sub">Loading the editor…</p>;

  const mermaid = mermaidOf(source);
  const section = selected ? now.sections.get(selected) : undefined;
  const out = now.edges.filter((e) => e.from === selected);

  const toolbar = (
    <div className="edit-bar" role="toolbar" aria-label="Edit diagram">
      <span className="hint">{from ? <>Connecting from <b>{label(from)}</b>: click the target step.</> : "Click a step to edit it."}</span>
      <Button small onClick={addStep}>
        + Step
      </Button>
      <Button small className={from ? "on" : undefined} aria-pressed={!!from} onClick={() => setFrom(from ? null : selected)} disabled={!from && !selected}>
        {from ? "Cancel connect" : "Connect"}
      </Button>
      <Button small onClick={undo} disabled={!changes}>
        Undo
      </Button>
      <Button
        small
        onClick={() => {
          onClose();
          if (changes) toast("Edits discarded.");
        }}
      >
        Discard
      </Button>
      <Button small variant="primary" disabled={!changes || !!opened} onClick={() => setConfirm(true)}>
        Save{changes ? ` · ${changes} ${changes === 1 ? "change" : "changes"}` : ""}
      </Button>
    </div>
  );

  return (
    <div className="row editing">
      <div className="main card pad stack">
        {toolbar}
        {confirm && (
          <section className="box save-sum" aria-label="Change summary">
            <span className="lbl">Change summary · saved to {spec.path} as a pull request</span>
            <ol>
              {applied.map((a, i) => (
                <li key={i}>{a.summary}</li>
              ))}
            </ol>
            <div className="btns">
              <Button small variant="primary" onClick={submit} disabled={save.isPending}>
                {save.isPending ? "Opening…" : "Open a pull request"}
              </Button>
              <Button small onClick={() => setConfirm(false)}>
                Keep editing
              </Button>
            </div>
          </section>
        )}
        {opened && (
          <section className="box save-sum" aria-label="Saved">
            <span className="lbl">Saved</span>
            <span>
              Pull request{" "}
              <a href={opened.url} target="_blank" rel="noreferrer noopener">
                #{opened.number}
              </a>{" "}
              on <span className="mono">{opened.branch}</span> changes {spec.path}. The spec here updates once it merges and the repo is indexed again.
            </span>
            <div className="btns">
              <Button small onClick={onClose}>
                Done
              </Button>
            </div>
          </section>
        )}
        {mermaid && (
          <div className="dia-wrap">
            <Diagram
              source={mermaid}
              label={`${spec.title} flow, editing`}
              status={status}
              selected={from ?? selected}
              onSelect={pick}
              tools={(zoom) => <div className="dia-tools">{zoom}</div>}
            />
          </div>
        )}
        <span className="lbl">Spec diff · written back to {spec.path} on save</span>
        {diff.length ? (
          <pre className="code" aria-label="Spec diff">
            {diff.map((l, i) =>
              l ? (
                <span key={i} className={l.kind === "+" ? "l-add" : l.kind === "-" ? "l-del" : ""}>
                  {`${l.kind} ${l.text}\n`}
                </span>
              ) : (
                <span key={i} className="l-com">
                  {"  …\n"}
                </span>
              ),
            )}
          </pre>
        ) : (
          <span className="sub" style={{ fontSize: 13 }}>
            No spec changes yet.
          </span>
        )}
      </div>
      <aside className="aside card pad stack" aria-label="Edit step">
        {selected && section ? (
          <>
            <div className="btns" style={{ justifyContent: "space-between" }}>
              <span className="lbl">Edit step</span>
              <span className="id">
                {flow}.{selected}
              </span>
            </div>
            <label className="fld">
              Label on the diagram
              <Field key={`${selected}-label`} label="Label on the diagram" value={label(selected)} onCommit={(v) => apply({ op: "renameStep", node: selected, label: v }, `Renamed ${label(selected)} to ${v}`)} />
            </label>
            <div className="stack-s">
              <span className="mono" style={{ color: "var(--accent)", fontSize: 11, fontWeight: 600 }}>
                requirements
              </span>
              {section.requirements.map((r) => (
                <div className="req-row" key={`${selected}-${r.tag}`}>
                  <span className="ears">WHEN</span>
                  <Field
                    label={`When, requirement ${r.tag}`}
                    value={r.condition}
                    onCommit={(v) => apply({ op: "setRequirement", node: selected, tag: r.tag, condition: v, response: r.response }, `Changed ${flow}.${selected}/${r.tag}: WHEN ${v}`)}
                  />
                  <button type="button" className="icon-btn x" aria-label={`Remove requirement ${r.tag}`} onClick={() => apply({ op: "removeRequirement", node: selected, tag: r.tag }, `Removed ${flow}.${selected}/${r.tag}`)}>
                    ×
                  </button>
                  <span className="ears">SHALL</span>
                  <Field
                    label={`The system shall, requirement ${r.tag}`}
                    value={r.response}
                    onCommit={(v) => apply({ op: "setRequirement", node: selected, tag: r.tag, condition: r.condition, response: v }, `Changed ${flow}.${selected}/${r.tag}: SHALL ${v}`)}
                  />
                </div>
              ))}
              <Button
                small
                style={{ alignSelf: "flex-start" }}
                onClick={() => {
                  if (apply({ op: "addRequirement", node: selected, condition: "something happens", response: "respond" }, `Added a requirement to ${label(selected)}`)) {
                    window.setTimeout(() => {
                      const all = document.querySelectorAll<HTMLInputElement>('input[aria-label^="When, requirement"]');
                      all[all.length - 1]?.select();
                    }, 60);
                  }
                }}
              >
                + Requirement
              </Button>
            </div>
            <div className="stack-s">
              <span className="mono" style={{ color: "var(--accent)", fontSize: 11, fontWeight: 600 }}>
                arrows out
              </span>
              {out.length ? (
                out.map((e) => (
                  <div className="btns" style={{ flexWrap: "nowrap" }} key={`${e.from}-${e.label}-${e.to}`}>
                    <span className="mono" style={{ whiteSpace: "nowrap", fontSize: 12 }}>
                      → {label(e.to)}
                    </span>
                    <span className="arrow-lbl">
                      <Field
                        mono
                        label={`Arrow label to ${label(e.to)}`}
                        value={e.label}
                        onCommit={(v) => apply({ op: "relabelEdge", from: e.from, label: e.label, to: e.to, newLabel: v }, `Relabelled the arrow ${label(e.from)} → ${label(e.to)} to ${v}`)}
                      />
                    </span>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Remove the arrow to ${label(e.to)}`}
                      onClick={() => apply({ op: "removeEdge", from: e.from, label: e.label, to: e.to }, `Removed the arrow ${label(e.from)} → ${label(e.to)}`)}
                    >
                      ×
                    </button>
                  </div>
                ))
              ) : (
                <span className="sub" style={{ fontSize: 12.5 }}>
                  None. Use Connect to add one.
                </span>
              )}
              <Button small style={{ alignSelf: "flex-start" }} onClick={() => setFrom(selected)}>
                + Arrow from here
              </Button>
            </div>
            <Button
              small
              className="danger"
              style={{ alignSelf: "flex-start" }}
              onClick={() => {
                if (apply({ op: "removeStep", node: selected }, `Deleted the step ${label(selected)}`, null)) toast("Step deleted. Undo brings it back.");
              }}
            >
              Delete step
            </Button>
            <span style={{ alignSelf: "flex-start" }}>
              <Pill tone={status[selected] === "new" ? "warn" : "idle"}>{status[selected] === "new" ? "changed" : "unchanged"}</Pill>
            </span>
          </>
        ) : (
          <span className="sub">Select a step to edit it.</span>
        )}
      </aside>
    </div>
  );
}
