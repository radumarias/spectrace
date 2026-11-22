// Whiteboards (T5.7): sketch ideas as Markdown notes and Mermaid diagrams of
// any type pele draws (the renderer devpage uses), then turn a flowchart into
// a draft spec that opens in the diagram editor and is saved as a pull
// request. `/board` lists the project's boards; `/board/<id>` is one board.
// A flowchart's text stays its source: the quick shapes rewrite it.
import { lazy, Suspense, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { useBoard, useBoards, useCreateBoard, useDeleteBoard, useSaveBoard, type Board } from "../api/boards";
import { useCurrentProject, type Project } from "../api/queries";
import { useNewSpec } from "../api/specs";
import { Button, Card, PageHead, Pill } from "../ui/parts";
import { useToast } from "../ui/Toast";
import { addBox, connect, draftSpec, isFlowchart, removeBox, rename, requirementsOf, segmentOf, shapesOf, type Block, type BlockKind } from "../spec/board";
import { Diagram } from "../spec/Diagram";

const SpecEditor = lazy(() => import("../spec/SpecEditor").then((m) => ({ default: m.SpecEditor })));

const STARTERS: Record<"flowchart" | "diagram" | "note", { kind: BlockKind; text: string }> = {
  flowchart: { kind: "mermaid", text: "flowchart LR" },
  diagram: { kind: "mermaid", text: "sequenceDiagram\n  User->>App: Sign up\n  App-->>User: Confirmation email" },
  note: { kind: "note", text: "Ideas.\n\n- <Box label>: WHEN something happens THE SYSTEM SHALL respond." },
};

const newId = () => `b${Math.random().toString(36).slice(2, 10)}`;

/** `/board`: the project's boards. */
export function BoardIndex() {
  const { project, isPending } = useCurrentProject();
  const boards = useBoards(project?.id);
  const create = useCreateBoard(project?.id ?? "");
  const navigate = useNavigate();
  const toast = useToast();
  if (isPending || boards.isPending) return <div className="page"><p className="sub">Loading…</p></div>;
  if (!project) return <Navigate to="/projects" replace />;
  const start = () =>
    create.mutate(
      { title: "Untitled board", blocks: [{ id: newId(), ...STARTERS.flowchart }] },
      { onSuccess: (b) => navigate(`/board/${b.id}`), onError: (e) => toast(e.message) },
    );
  return (
    <div className="page">
      <PageHead eyebrow="Whiteboard" title="Whiteboard" sub="Sketch with Mermaid and notes, then turn a flowchart into a spec.">
        <Button variant="primary" onClick={start} disabled={create.isPending}>
          New board
        </Button>
      </PageHead>
      {boards.error ? (
        <Card>
          <p className="err">{boards.error.message}</p>
        </Card>
      ) : boards.data?.length ? (
        <div className="stack">
          {boards.data.map((b) => (
            <Link key={b.id} className="card pr-row" to={`/board/${b.id}`}>
              <div className="stack-s" style={{ gap: 4, minWidth: 0 }}>
                <b style={{ font: "600 15px var(--f-display)" }}>{b.title}</b>
                <span className="meta">
                  {b.blocks} {b.blocks === 1 ? "block" : "blocks"} · changed {new Date(b.updatedAt).toLocaleString()}
                </span>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <Card>
          <p className="sub">No boards yet. Start one to sketch a flow before it becomes a spec.</p>
        </Card>
      )}
    </div>
  );
}

/** Any Mermaid diagram pele draws, loaded with its diagram type on demand. */
function MermaidPreview({ text, label }: { text: string; label: string }) {
  const prefix = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [out, setOut] = useState<{ svg: string } | { error: string } | null>(null);
  useEffect(() => {
    let live = true;
    import("pele/lazy")
      .then((m) => m.renderAsync(text, { idPrefix: `wb${prefix}`, linkSchemes: ["http", "https", "mailto"] }))
      .then(
        (r) => live && setOut({ svg: r.svg }),
        (e: unknown) => live && setOut({ error: e instanceof Error ? e.message : String(e) }),
      );
    return () => {
      live = false;
    };
  }, [text, prefix]);
  if (!out) return <p className="sub">Drawing…</p>;
  if ("error" in out) return <p className="dia-error" role="alert">{out.error}</p>;
  // pele builds the SVG from the board's own text and escapes labels.
  return <div className="board-svg" role="img" aria-label={label} dangerouslySetInnerHTML={{ __html: out.svg }} />;
}

/** Add a box, connect two, rename, delete: each rewrites the flowchart's text. */
function QuickShapes({ text, onText, n, onDraft }: { text: string; onText: (t: string) => void; n: number; onDraft: () => void }) {
  const [sel, setSel] = useState<string | null>(null);
  const [from, setFrom] = useState<string | null>(null);
  const { boxes } = shapesOf(text);
  const selected = boxes.find((b) => b.id === sel) ?? null;
  const [name, setName] = useState("");
  useEffect(() => setName(selected?.label ?? ""), [selected?.id, selected?.label]);

  const pick = (id: string) => {
    if (from) {
      if (from !== id) onText(connect(text, from, id));
      setFrom(null);
      setSel(id);
      return;
    }
    setSel(id);
  };
  const commitName = () => {
    if (selected && name.trim() && name.trim() !== selected.label) onText(rename(text, selected.id, name.trim()));
  };
  return (
    <>
      <div className="edit-bar" role="toolbar" aria-label={`Quick shapes, block ${n}`}>
        <span className="hint">{from ? <>Connecting from <b>{boxes.find((b) => b.id === from)?.label}</b>: click the target box.</> : "Click a box to select it."}</span>
        <Button
          small
          onClick={() => {
            const r = addBox(text, `Box ${boxes.length + 1}`, sel);
            onText(r.text);
            setSel(r.id);
          }}
        >
          + Box
        </Button>
        <Button small className={from ? "on" : undefined} aria-pressed={!!from} disabled={!from && !selected} onClick={() => setFrom(from ? null : sel)}>
          {from ? "Cancel connect" : "Connect"}
        </Button>
        <Button
          small
          disabled={!selected}
          onClick={() => {
            if (!selected) return;
            onText(removeBox(text, selected.id));
            setSel(null);
          }}
        >
          Delete box
        </Button>
        <Button small variant="primary" disabled={!boxes.length} onClick={onDraft}>
          Turn into requirements
        </Button>
      </div>
      {selected && (
        <label className="fld">
          Box label
          <input
            value={name}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        </label>
      )}
      {boxes.length ? (
        <div className="dia-wrap">
          <Diagram source={text} label={`Flowchart, block ${n}`} selected={from ?? sel} onSelect={pick} tools={(zoom) => <div className="dia-tools">{zoom}</div>} />
        </div>
      ) : (
        <p className="sub" style={{ fontSize: 13 }}>
          An empty flowchart. Add a box, or write Mermaid in the text.
        </p>
      )}
    </>
  );
}

function BlockCard({ block, n, onChange, onRemove, onDraft }: { block: Block; n: number; onChange: (b: Block) => void; onRemove: () => void; onDraft: () => void }) {
  const text = useDeferredValue(block.text);
  const flowchart = block.kind === "mermaid" && isFlowchart(text);
  return (
    <section className="card pad stack board-block" aria-label={`Block ${n}`}>
      <div className="btns" style={{ justifyContent: "space-between" }}>
        <span className="lbl">{block.kind === "note" ? "Note" : flowchart ? "Flowchart" : "Mermaid diagram"}</span>
        <button type="button" className="icon-btn" aria-label={`Remove block ${n}`} onClick={onRemove}>
          ×
        </button>
      </div>
      <div className="board-cols">
        <textarea
          className="board-text mono"
          aria-label={block.kind === "note" ? `Note, block ${n}` : `Mermaid text, block ${n}`}
          value={block.text}
          spellCheck={block.kind === "note"}
          onChange={(e) => onChange({ ...block, text: e.target.value })}
        />
        <div className="board-preview stack">
          {block.kind === "note" ? (
            <div className="md">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
            </div>
          ) : flowchart ? (
            <QuickShapes text={block.text} n={n} onText={(t) => onChange({ ...block, text: t })} onDraft={onDraft} />
          ) : (
            <MermaidPreview text={text} label={`Diagram, block ${n}`} />
          )}
        </div>
      </div>
    </section>
  );
}

/** The draft's place: which repo, and the flow id that names the file. */
function DraftSetup({ project, board, block, onOpen, onCancel }: { project: Project; board: Board; block: Block; onOpen: (d: { repoId: string; flow: string; title: string }) => void; onCancel: () => void }) {
  const [repoId, setRepoId] = useState(project.repos[0]?.id ?? "");
  const [title, setTitle] = useState(board.title === "Untitled board" ? "New flow" : board.title);
  const [flow, setFlow] = useState(segmentOf(title, "flow"));
  const touched = useRef(false);
  const boxes = shapesOf(block.text).boxes.length;
  return (
    <section className="card pad stack" aria-label="Turn into requirements">
      <span className="lbl">Turn into requirements</span>
      <p className="sub" style={{ fontSize: 13 }}>
        The flowchart's {boxes} {boxes === 1 ? "box becomes a step" : "boxes become steps"} and its arrows become labelled arrows. Note lines written as <span className="mono">- Box label: WHEN … THE SYSTEM SHALL ….</span> become that step's requirements. Other diagrams on the board are kept as sketches in the file.
      </p>
      <label className="fld">
        Title
        <input
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            if (!touched.current) setFlow(segmentOf(e.target.value, "flow"));
          }}
        />
      </label>
      <label className="fld">
        Flow id (the file name)
        <input
          className="mono"
          value={flow}
          onChange={(e) => {
            touched.current = true;
            setFlow(e.target.value);
          }}
        />
      </label>
      <label className="fld">
        Repo
        <select value={repoId} onChange={(e) => setRepoId(e.target.value)}>
          {project.repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.full_name}
            </option>
          ))}
        </select>
      </label>
      <span className="mono sub" style={{ fontSize: 12 }}>
        spec/{flow}.md
      </span>
      <div className="btns">
        <Button variant="primary" small disabled={!repoId || !/^[a-z][a-z0-9_]{0,39}$/.test(flow)} onClick={() => onOpen({ repoId, flow, title: title.trim() || flow })}>
          Open in the diagram editor
        </Button>
        <Button small onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {!project.repos.length && <p className="err">Add a repo to the project first; the spec is saved to it as a pull request.</p>}
    </section>
  );
}

/** `/board/:boardId`: one board, saved as you go. */
export function BoardPage() {
  const { boardId } = useParams();
  const { project, isPending } = useCurrentProject();
  const query = useBoard(project?.id, boardId);
  if (isPending || query.isPending) return <div className="page"><p className="sub">Loading…</p></div>;
  if (!project) return <Navigate to="/projects" replace />;
  if (query.error) return <div className="page"><Card><p className="err">{query.error.message}</p></Card></div>;
  if (!query.data) return <Navigate to="/board" replace />;
  return <BoardEditor key={query.data.id} project={project} board={query.data} />;
}

function BoardEditor({ project, board }: { project: Project; board: Board }) {
  const toast = useToast();
  const navigate = useNavigate();
  const save = useSaveBoard(project.id, board.id);
  const remove = useDeleteBoard(project.id);
  const newSpec = useNewSpec(project.id);
  const [title, setTitle] = useState(board.title);
  const [blocks, setBlocks] = useState<Block[]>(board.blocks);
  const [state, setState] = useState<"saved" | "saving" | "error">("saved");
  const [drafting, setDrafting] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ repoId: string; path: string; title: string; flow: string; source: string; summary: string } | null>(null);
  // The content last loaded from the server: the page's own copy is saved
  // only when it differs, so a board the coordinator drew is not saved back.
  const synced = useRef(JSON.stringify({ title: board.title, blocks: board.blocks }));

  // The coordinator drew on the board (or a change of its was undone): take that version.
  useEffect(() => {
    const next = JSON.stringify({ title: board.title, blocks: board.blocks });
    if (next === synced.current) return;
    synced.current = next;
    setTitle(board.title);
    setBlocks(board.blocks);
    setState("saved");
  }, [board]);

  // Saved 600 ms after the last change.
  useEffect(() => {
    if (JSON.stringify({ title, blocks }) === synced.current) return;
    setState("saving");
    const t = window.setTimeout(() => {
      save.mutate(
        { title: title.trim() || "Untitled board", blocks },
        {
          onSuccess: (saved) => {
            synced.current = JSON.stringify({ title: saved.title, blocks: saved.blocks });
            setState("saved");
          },
          onError: () => setState("error"),
        },
      );
    }, 600);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- save is stable enough; only content changes save
  }, [title, blocks]);

  const add = (k: keyof typeof STARTERS) => setBlocks((b) => [...b, { id: newId(), ...STARTERS[k] }]);
  const drafted = useMemo(() => blocks.find((b) => b.id === drafting) ?? null, [blocks, drafting]);

  const openDraft = async (d: { repoId: string; flow: string; title: string }) => {
    if (!drafted) return;
    try {
      const core = await import("../spec/core");
      await core.loadCore();
      const others = blocks.filter((b) => b.kind === "mermaid" && b.id !== drafted.id).map((b) => b.text);
      const { source, ids } = draftSpec(d.title, d.flow, drafted.text, others);
      const path = `spec/${d.flow}.md`;
      let out = source;
      const reqs = requirementsOf(blocks.filter((b) => b.kind === "note").map((b) => b.text), shapesOf(drafted.text).boxes);
      for (const [box, list] of reqs) for (const r of list) out = core.editSpec(path, out, { op: "addRequirement", node: ids.get(box)!, ...r });
      const errors = core.parseSpec(path, out).diagnostics.filter((x) => x.code.startsWith("S"));
      if (errors.length) return toast(`The draft has errors: ${errors.map((x) => `${x.code} ${x.message}`).join("; ")}`);
      setDraft({ repoId: d.repoId, path, title: d.title, flow: d.flow, source: out, summary: `Drafted from the whiteboard ${title.trim() || "Untitled board"}` });
      setDrafting(null);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  if (draft) {
    return (
      <div className="page">
        <div className="head">
          <div>
            <span className="mono sub" style={{ fontSize: 12, overflowWrap: "anywhere" }}>
              {project.repos.find((r) => r.id === draft.repoId)?.full_name} / {draft.path}
            </span>
            <h1>
              {draft.title} <Pill tone="acc">draft</Pill>
            </h1>
          </div>
        </div>
        <Suspense fallback={<p className="sub">Loading the editor…</p>}>
          <SpecEditor
            spec={{ path: draft.path, title: draft.title, flow: draft.flow, source: draft.source, draft: draft.summary }}
            onSave={(body) => newSpec.mutateAsync({ repoId: draft.repoId, path: draft.path, ...body })}
            onClose={() => setDraft(null)}
          />
        </Suspense>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="head">
        <div style={{ flex: "1 1 260px" }}>
          <span className="eyebrow">Whiteboard</span>
          <input className="board-title" aria-label="Board title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="btns">
          <span className="sub" role="status" style={{ fontSize: 12 }}>
            {state === "saving" ? "Saving…" : state === "error" ? "Not saved, retrying on the next change" : "Saved"}
          </span>
          <Button
            small
            onClick={() =>
              remove.mutate(board.id, {
                onSuccess: () => {
                  toast("Board deleted.");
                  navigate("/board");
                },
                onError: (e) => toast(e.message),
              })
            }
          >
            Delete board
          </Button>
        </div>
      </div>
      <div className="btns">
        <Button small onClick={() => add("flowchart")}>
          + Flowchart
        </Button>
        <Button small onClick={() => add("diagram")}>
          + Diagram
        </Button>
        <Button small onClick={() => add("note")}>
          + Note
        </Button>
        <span className="sub" style={{ fontSize: 12 }}>
          Any Mermaid type pele draws: flowchart, sequence, state, class, ER, mindmap, gantt and more.
        </span>
      </div>
      {drafted && <DraftSetup project={project} board={{ ...board, title }} block={drafted} onOpen={(d) => void openDraft(d)} onCancel={() => setDrafting(null)} />}
      {blocks.length === 0 && (
        <Card>
          <p className="sub">An empty board. Add a flowchart, another diagram or a note.</p>
        </Card>
      )}
      {blocks.map((b, i) => (
        <BlockCard
          key={b.id}
          block={b}
          n={i + 1}
          onChange={(nb) => setBlocks((all) => all.map((x) => (x.id === nb.id ? nb : x)))}
          onRemove={() => setBlocks((all) => all.filter((x) => x.id !== b.id))}
          onDraft={() => setDrafting(b.id)}
        />
      ))}
    </div>
  );
}
