// The coordinator's pen on the whiteboard (requirements studio, phase 1).
//
// While the user talks with the coordinator on a board, the coordinator may
// change the board in the same reply: add a note or a diagram, rewrite a
// block, remove one, rename the board. Those changes are board ops. They are
// checked here, applied to the stored board, and the board as it was before
// is kept on the message so one click undoes them.

export type BlockKind = "note" | "mermaid";
export interface BoardBlock {
  id: string;
  kind: BlockKind;
  text: string;
}
export interface BoardContent {
  title: string;
  blocks: BoardBlock[];
}

export type BoardOp =
  | { op: "add"; kind: BlockKind; text: string; after?: string }
  | { op: "set"; id: string; text: string }
  | { op: "remove"; id: string }
  | { op: "title"; text: string };

export const MAX_OPS = 8;
export const MAX_BLOCKS = 100;
const MAX_TEXT = 50_000;
const BLOCK_ID = /^[A-Za-z0-9_-]{1,40}$/;

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** The ops Claude asked for, without anything malformed. */
export function cleanOps(raw: unknown): BoardOp[] {
  if (!Array.isArray(raw)) return [];
  const out: BoardOp[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const text = str(o.text);
    const id = str(o.id)?.trim();
    switch (str(o.op)) {
      case "add": {
        const kind = str(o.kind);
        if ((kind !== "note" && kind !== "mermaid") || !text?.trim() || text.length > MAX_TEXT) break;
        const after = str(o.after)?.trim();
        out.push(after && BLOCK_ID.test(after) ? { op: "add", kind, text, after } : { op: "add", kind, text });
        break;
      }
      case "set":
        if (id && BLOCK_ID.test(id) && text?.trim() && text.length <= MAX_TEXT) out.push({ op: "set", id, text });
        break;
      case "remove":
        if (id && BLOCK_ID.test(id)) out.push({ op: "remove", id });
        break;
      case "title": {
        const t = text?.trim().slice(0, 120);
        if (t) out.push({ op: "title", text: t });
        break;
      }
    }
    if (out.length === MAX_OPS) break;
  }
  return out;
}

const what = (b: { kind: BlockKind; text: string }) => {
  if (b.kind === "note") return "a note";
  const head = b.text.trim().split(/\s/)[0] ?? "";
  if (/^(flowchart|graph)$/.test(head)) return "a flowchart";
  if (head === "sequenceDiagram") return "a sequence diagram";
  if (/^stateDiagram/.test(head)) return "a state diagram";
  if (head === "erDiagram") return "an ER diagram";
  if (head === "classDiagram") return "a class diagram";
  if (head === "mindmap") return "a mind map";
  return "a diagram";
};

/** The board after `ops`, and what changed, in words ("Added a flowchart"). Ops on blocks that are not there are skipped. */
export function applyOps(board: BoardContent, ops: BoardOp[], newId: () => string = () => `b${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`): BoardContent & { changes: string[] } {
  let title = board.title;
  const blocks = board.blocks.map((b) => ({ ...b }));
  const changes: string[] = [];
  const nth = (id: string) => blocks.findIndex((b) => b.id === id);
  for (const op of ops) {
    if (op.op === "title") {
      if (op.text !== title) {
        title = op.text;
        changes.push(`Renamed the board to ${op.text}`);
      }
    } else if (op.op === "add") {
      if (blocks.length >= MAX_BLOCKS) continue;
      const block = { id: newId(), kind: op.kind, text: op.text };
      const at = op.after ? nth(op.after) : -1;
      if (at >= 0) blocks.splice(at + 1, 0, block);
      else blocks.push(block);
      changes.push(`Added ${what(block)}`);
    } else if (op.op === "set") {
      const i = nth(op.id);
      const b = blocks[i];
      if (!b || b.text === op.text) continue;
      blocks[i] = { ...b, text: op.text };
      changes.push(`Changed ${what(b)} (block ${i + 1})`);
    } else {
      const i = nth(op.id);
      const b = blocks[i];
      if (!b) continue;
      blocks.splice(i, 1);
      changes.push(`Removed ${what(b)} (block ${i + 1})`);
    }
  }
  return { title, blocks, changes };
}

/** The board as the coordinator reads it in its prompt. */
export function boardText(id: string, board: BoardContent, limit = 24_000): string {
  const lines = [`The whiteboard "${board.title}" (board id=${id}), ${board.blocks.length} blocks in order:`];
  if (!board.blocks.length) lines.push("(empty)");
  for (const b of board.blocks) lines.push(`[${b.id}] ${b.kind}:`, b.text, "");
  const text = lines.join("\n");
  return text.length > limit ? `${text.slice(0, limit)}\n(cut)` : text;
}
