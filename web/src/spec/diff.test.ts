import { describe, expect, it } from "vitest";
import { diffLines, hunks } from "./diff";

describe("diffLines", () => {
  it("keeps common lines and marks the rest", () => {
    const d = diffLines("a\nb\nc\nd", "a\nB\nc\nd\ne");
    expect(d.map((l) => `${l.kind}${l.text}`)).toEqual([" a", "-b", "+B", " c", " d", "+e"]);
  });

  it("is empty of changes for equal text", () => {
    expect(diffLines("x\ny", "x\ny").every((l) => l.kind === " ")).toBe(true);
    expect(hunks(diffLines("x\ny", "x\ny"))).toEqual([]);
  });

  it("shows each change with one line of context and gaps between", () => {
    const before = ["1", "2", "3", "4", "5", "6", "7", "8"].join("\n");
    const after = ["1", "two", "3", "4", "5", "6", "seven", "8"].join("\n");
    const h = hunks(diffLines(before, after)).map((l) => (l ? `${l.kind}${l.text}` : "…"));
    expect(h).toEqual([" 1", "-2", "+two", " 3", "…", " 6", "-7", "+seven", " 8"]);
  });
});
