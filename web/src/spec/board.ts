// The whiteboard's flowchart helpers (T5.7). A flowchart block's Mermaid text
// is its source: quick shapes (add a box, connect, rename, delete) rewrite the
// text, and "Turn into requirements" makes a draft spec file from it.

export type BlockKind = "note" | "mermaid";
export interface Block {
  id: string;
  kind: BlockKind;
  text: string;
}

export interface Box {
  id: string;
  label: string;
}
export interface Arrow {
  from: string;
  to: string;
  label: string;
}

const HEAD = /^\s*(?:flowchart|graph)\s+(LR|RL|TD|TB|BT)\b/;
const NODE = /^\s*([A-Za-z][\w]*)\s*(?:\[\s*"?([^\]"]*)"?\s*\]|\(\s*"?([^)"]*)"?\s*\)|\{\s*"?([^}"]*)"?\s*\})\s*$/;
const SHAPE = String.raw`(?:\[\s*"?([^\]"]*)"?\s*\]|\(\s*"?([^)"]*)"?\s*\)|\{\s*"?([^}"]*)"?\s*\})`;
const EDGE = new RegExp(String.raw`^\s*([A-Za-z]\w*)\s*${SHAPE}?\s*-{2,3}>?\s*(?:\|\s*([^|]*?)\s*\|)?\s*([A-Za-z]\w*)\s*${SHAPE}?\s*$`);
const EDGE_TEXT = /^\s*([A-Za-z][\w]*)\s*--\s+([^-][^>]*?)\s+-->\s*([A-Za-z][\w]*)\s*$/;

/** Whether `text` is a flowchart (the only diagram type the quick shapes and specs understand). */
export const isFlowchart = (text: string) => HEAD.test(text.split("\n").find((l) => l.trim() && !l.trim().startsWith("%%")) ?? "");

/** The direction of a flowchart, `LR` when it has none. */
export const directionOf = (text: string) => (HEAD.exec(text.split("\n").find((l) => HEAD.test(l)) ?? "")?.[1] ?? "LR") as "LR" | "RL" | "TD" | "TB" | "BT";

/** Boxes and arrows of a flowchart, from the forms people write by hand: `a[A]`, `a(A)`, `a{A}`, `a --> b`, `a -->|x| b`, `a -- x --> b`, and inline `a[A] --> b[B]`. */
export function shapesOf(text: string): { boxes: Box[]; arrows: Arrow[] } {
  const boxes = new Map<string, Box>();
  const arrows: Arrow[] = [];
  const box = (id: string, label?: string) => {
    const had = boxes.get(id);
    if (!had) boxes.set(id, { id, label: label?.trim() || id });
    else if (label?.trim()) had.label = label.trim();
  };
  for (const line of text.split("\n")) {
    if (HEAD.test(line) || /^\s*(%%|click\b|classDef\b|class\b|style\b|linkStyle\b|subgraph\b|end\b)/.test(line)) continue;
    const n = NODE.exec(line);
    if (n) {
      box(n[1]!, n[2] ?? n[3] ?? n[4]);
      continue;
    }
    const t = EDGE_TEXT.exec(line);
    if (t) {
      box(t[1]!);
      box(t[3]!);
      arrows.push({ from: t[1]!, to: t[3]!, label: t[2]!.trim() });
      continue;
    }
    const e = EDGE.exec(line);
    if (e) {
      box(e[1]!, e[2] ?? e[3] ?? e[4]);
      box(e[6]!, e[7] ?? e[8] ?? e[9]);
      arrows.push({ from: e[1]!, to: e[6]!, label: (e[5] ?? "").trim() });
    }
  }
  return { boxes: [...boxes.values()], arrows };
}

/** A flowchart's text from its shapes, one construct per line (the spec format's own layout). */
export function flowchartOf(dir: string, boxes: Box[], arrows: Arrow[]): string {
  const clean = (t: string) => t.replace(/[[\]|"]/g, " ").replace(/\s+/g, " ").trim();
  return [
    `flowchart ${dir}`,
    ...boxes.map((b) => `  ${b.id}[${clean(b.label) || b.id}]`),
    ...arrows.map((a) => (clean(a.label) ? `  ${a.from} -->|${clean(a.label)}| ${a.to}` : `  ${a.from} --> ${a.to}`)),
  ].join("\n");
}

/** Quick shapes: each returns the block's new text. */
export function addBox(text: string, label: string, after?: string | null): { text: string; id: string } {
  const { boxes, arrows } = shapesOf(text);
  let n = boxes.length + 1;
  while (boxes.some((b) => b.id === `n${n}`)) n++;
  const id = `n${n}`;
  const next = [...arrows, ...(after && boxes.some((b) => b.id === after) ? [{ from: after, to: id, label: "" }] : [])];
  return { text: flowchartOf(directionOf(text), [...boxes, { id, label }], next), id };
}
export function connect(text: string, from: string, to: string, label = ""): string {
  const { boxes, arrows } = shapesOf(text);
  if (arrows.some((a) => a.from === from && a.to === to)) return text;
  return flowchartOf(directionOf(text), boxes, [...arrows, { from, to, label }]);
}
export function rename(text: string, id: string, label: string): string {
  const { boxes, arrows } = shapesOf(text);
  return flowchartOf(directionOf(text), boxes.map((b) => (b.id === id ? { ...b, label } : b)), arrows);
}
export function removeBox(text: string, id: string): string {
  const { boxes, arrows } = shapesOf(text);
  return flowchartOf(directionOf(text), boxes.filter((b) => b.id !== id), arrows.filter((a) => a.from !== id && a.to !== id));
}

/** `Store front!` → `store_front`, a valid spec segment (falls back to `fallback`). */
export function segmentOf(text: string, fallback: string): string {
  let s = text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(s)) s = s ? `${fallback}_${s}` : fallback;
  return s.slice(0, 40).replace(/_+$/, "");
}

/** `- <Box label>: WHEN … THE SYSTEM SHALL ….` lines of the board's notes, by box id. */
export function requirementsOf(notes: string[], boxes: Box[]): Map<string, { condition: string; response: string }[]> {
  const out = new Map<string, { condition: string; response: string }[]>();
  const byLabel = new Map(boxes.map((b) => [b.label.toLowerCase(), b.id]));
  for (const note of notes) {
    for (const line of note.split("\n")) {
      const m = /^\s*[-*]?\s*([^:]+?)\s*:\s*WHEN\s+(.+?)\s+THE SYSTEM SHALL\s+(.+?)\.?\s*$/.exec(line);
      const id = m && (byLabel.get(m[1]!.toLowerCase()) ?? boxes.find((b) => b.id === m[1])?.id);
      if (m && id) out.set(id, [...(out.get(id) ?? []), { condition: m[2]!.trim(), response: m[3]!.trim() }]);
    }
  }
  return out;
}

/**
 * A draft spec file from a flowchart: the title, the diagram in the spec
 * format (node ids made valid, every arrow labelled, a `spec://` click per
 * node), and one empty section per box. Requirement lines are added after,
 * through the core writer. Other diagrams on the board go in as prose: the
 * format allows one diagram, so they are kept as plain code blocks.
 */
export function draftSpec(title: string, flow: string, text: string, others: string[] = []): { source: string; ids: Map<string, string> } {
  const { boxes, arrows } = shapesOf(text);
  const ids = new Map<string, string>();
  for (const b of boxes) {
    let id = segmentOf(b.label, "step");
    let n = 2;
    while ([...ids.values()].includes(id)) id = `${segmentOf(b.label, "step").slice(0, 36)}_${n++}`;
    ids.set(b.id, id);
  }
  const clean = (t: string) => t.replace(/[[\]|"]/g, " ").replace(/\s+/g, " ").trim();
  const dia = [
    `flowchart ${directionOf(text) === "TB" ? "TD" : directionOf(text)}`,
    ...boxes.map((b) => `  ${ids.get(b.id)}[${clean(b.label) || ids.get(b.id)}]`),
    "",
    ...arrows.map((a) => `  ${ids.get(a.from)} -->|${clean(a.label) || "next"}| ${ids.get(a.to)}`),
    "",
    ...boxes.map((b) => `  click ${ids.get(b.id)} href "spec://${flow}.${ids.get(b.id)}"`),
  ];
  const parts = [`# ${clean(title) || flow} {#${flow}}`, "", "```mermaid", ...dia, "```", ""];
  if (others.length) {
    parts.push("Sketches from the whiteboard:", "");
    for (const o of others) parts.push("```text", o.trimEnd(), "```", "");
  }
  for (const b of boxes) parts.push(`## ${clean(b.label) || ids.get(b.id)} {#${flow}.${ids.get(b.id)}}`, "");
  return { source: `${parts.join("\n").trimEnd()}\n`, ids };
}
