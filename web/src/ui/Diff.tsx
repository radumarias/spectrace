import { useMemo } from "react";

export interface DiffLine {
  kind: "hunk" | "add" | "del" | "ctx" | "note";
  /** Line number in the old file; null for added lines and hunk headers. */
  oldNo: number | null;
  newNo: number | null;
  text: string;
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
      out.push({ kind: "hunk", oldNo: null, newNo: null, text: raw });
    } else if (raw.startsWith("\\")) {
      out.push({ kind: "note", oldNo: null, newNo: null, text: raw });
    } else if (raw.startsWith("+")) {
      out.push({ kind: "add", oldNo: null, newNo: newNo++, text: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      out.push({ kind: "del", oldNo: oldNo++, newNo: null, text: raw.slice(1) });
    } else {
      out.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: raw.slice(1) });
    }
  }
  return out;
}

const MARK = { add: "+", del: "−", ctx: " ", hunk: "", note: "" } as const;

export function Diff({ patch }: { patch: string }) {
  const lines = useMemo(() => parsePatch(patch), [patch]);
  return (
    <div className="diff" role="table" aria-label="Changes">
      {lines.map((l, i) => (
        <div key={i} className={`dl dl-${l.kind}`} role="row">
          <span className="dn" aria-hidden="true">{l.oldNo ?? ""}</span>
          <span className="dn" aria-hidden="true">{l.newNo ?? ""}</span>
          <span className="dm" aria-hidden="true">{MARK[l.kind]}</span>
          <code className="dt">{l.kind === "hunk" || l.kind === "note" ? l.text : l.text || " "}</code>
        </div>
      ))}
    </div>
  );
}
