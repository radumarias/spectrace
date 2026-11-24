import { useMemo, useState } from "react";

export interface DiffLine {
  kind: "hunk" | "add" | "del" | "ctx" | "note";
  /** Line number in the old file; null for added lines and hunk headers. */
  oldNo: number | null;
  newNo: number | null;
  text: string;
  /** Where the line sits in the new file: its own number, or for a removed line the new line it comes before. */
  at: number;
}

/** A range of lines in the new file, both ends included. */
export interface Range {
  start: number;
  end: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Split GitHub's unified diff of one file into numbered lines. */
export function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.replace(/\r?\n$/, "").split("\n")) {
    const hunk = HUNK.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      out.push({ kind: "hunk", oldNo: null, newNo: null, text: raw, at: newNo });
    } else if (raw.startsWith("\\")) {
      out.push({ kind: "note", oldNo: null, newNo: null, text: raw, at: newNo });
    } else if (raw.startsWith("+")) {
      out.push({ kind: "add", oldNo: null, newNo, text: raw.slice(1), at: newNo++ });
    } else if (raw.startsWith("-")) {
      out.push({ kind: "del", oldNo: oldNo++, newNo: null, text: raw.slice(1), at: newNo });
    } else {
      out.push({ kind: "ctx", oldNo: oldNo++, newNo, text: raw.slice(1), at: newNo++ });
    }
  }
  return out;
}

/** Lines of context kept around a step's own lines. */
const CONTEXT = 3;

/** A row to draw: a diff line, or a gap standing for lines left out. */
export type Row = { line: DiffLine } | { gap: number };

/** Hunks of a parsed patch, each starting with its header. */
function hunks(lines: DiffLine[]): DiffLine[][] {
  const out: DiffLine[][] = [];
  for (const l of lines) {
    if (l.kind === "hunk" || out.length === 0) out.push([]);
    out[out.length - 1]!.push(l);
  }
  return out;
}

const changed = (h: DiffLine[]) => h.some((l) => l.kind === "add" || l.kind === "del");

/** Meaningful lines of a reviewer's excerpt, without their + or − marks, to find the hunks it quotes. */
function quoted(excerpt: string): string[] {
  return excerpt
    .split("\n")
    .map((l) => l.replace(/^[+\-−]\s?/, "").trim())
    .filter((l) => l.length >= 6 && l !== "…");
}

/**
 * The rows of a step's part of a file. With ranges: the changed lines inside them and a little context;
 * else with an excerpt: the hunks that contain its lines. Otherwise, or when nothing matches, every row.
 * `hidden` counts the changed lines left out.
 */
export function focus(lines: DiffLine[], ranges: Range[], excerpt = ""): { rows: Row[]; hidden: number } {
  const all = lines.map((line) => ({ line }));
  const countChanged = (ls: DiffLine[]) => ls.filter((l) => l.kind === "add" || l.kind === "del").length;
  if (ranges.length > 0) {
    const near = (at: number) => ranges.some((r) => at >= r.start - CONTEXT && at <= r.end + CONTEXT);
    const own = (l: DiffLine) => (l.kind === "add" || l.kind === "del") && ranges.some((r) => l.at >= r.start && l.at <= r.end);
    if (!lines.some(own)) return { rows: all, hidden: 0 };
    const rows: Row[] = [];
    let skipped = 0;
    let hidden = 0;
    for (const h of hunks(lines)) {
      const body = h.filter((l) => l.kind !== "hunk");
      if (!body.some(own)) {
        hidden += countChanged(body);
        continue;
      }
      const head = h[0]!.kind === "hunk" ? h[0]! : null;
      if (head) rows.push({ line: head });
      for (const l of body) {
        if (near(l.at)) {
          if (skipped) rows.push({ gap: skipped });
          skipped = 0;
          rows.push({ line: l });
        } else {
          skipped++;
          if (l.kind === "add" || l.kind === "del") hidden++;
        }
      }
      if (skipped) rows.push({ gap: skipped });
      skipped = 0;
    }
    return { rows, hidden };
  }
  const want = quoted(excerpt);
  if (want.length > 0) {
    const hs = hunks(lines);
    const keep = hs.filter((h) => changed(h) && h.some((l) => l.kind !== "hunk" && want.some((w) => l.text.trim().includes(w))));
    if (keep.length > 0 && keep.length < hs.length) {
      return { rows: keep.flat().map((line) => ({ line })), hidden: hs.filter((h) => !keep.includes(h)).reduce((n, h) => n + countChanged(h), 0) };
    }
  }
  return { rows: all, hidden: 0 };
}

const NONE: Range[] = [];

const MARK = { add: "+", del: "−", ctx: " ", hunk: "", note: "" } as const;

/** How many rows a diff shows before it asks to be expanded. */
export const PREVIEW_ROWS = 40;

/**
 * One file's diff. `ranges` / `excerpt` narrow it to the lines of one walkthrough step, with a button
 * for the rest of the file; a long diff shows its first rows and a button for the others.
 */
export function Diff({ patch, ranges = NONE, excerpt = "", preview = PREVIEW_ROWS }: { patch: string; ranges?: Range[]; excerpt?: string; preview?: number }) {
  const lines = useMemo(() => parsePatch(patch), [patch]);
  const focused = useMemo(() => focus(lines, ranges, excerpt), [lines, ranges, excerpt]);
  const [whole, setWhole] = useState(false);
  const [long, setLong] = useState(false);
  const rows: Row[] = whole ? lines.map((line) => ({ line })) : focused.rows;
  const cut = !long && rows.length > preview + 10;
  const shown = cut ? rows.slice(0, preview) : rows;
  return (
    <>
      <div className="diff" role="table" aria-label="Changes">
        {shown.map((r, i) =>
          "gap" in r ? (
            <div key={i} className="dl dl-gap" role="row">
              <code className="dt">⋯ {r.gap} {r.gap === 1 ? "line" : "lines"} not in this part</code>
            </div>
          ) : (
            <div key={i} className={`dl dl-${r.line.kind}`} role="row">
              <span className="dn" aria-hidden="true">{r.line.oldNo ?? ""}</span>
              <span className="dn" aria-hidden="true">{r.line.newNo ?? ""}</span>
              <span className="dm" aria-hidden="true">{MARK[r.line.kind]}</span>
              <code className="dt">{r.line.kind === "hunk" || r.line.kind === "note" ? r.line.text : r.line.text || " "}</code>
            </div>
          ),
        )}
      </div>
      {(cut || (!whole && focused.hidden > 0)) && (
        <div className="diff-more">
          {cut && (
            <button type="button" className="linkish" onClick={() => setLong(true)}>
              Show {rows.length - preview} more lines
            </button>
          )}
          {!whole && focused.hidden > 0 && (
            <button type="button" className="linkish" onClick={() => setWhole(true)}>
              Show the whole file's changes ({focused.hidden} more changed {focused.hidden === 1 ? "line" : "lines"})
            </button>
          )}
        </div>
      )}
    </>
  );
}
