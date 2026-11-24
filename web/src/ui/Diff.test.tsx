import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { Diff, focus, parsePatch } from "./Diff";

afterEach(cleanup);

// Two hunks: lines 2-3 changed near the top, line 40 changed further down.
const PATCH = [
  "@@ -1,4 +1,5 @@",
  " a",
  "-b",
  "+B",
  "+C",
  " d",
  " e",
  "@@ -38,3 +39,3 @@ fn tail()",
  " x",
  "-let y = old();",
  "+let y = new();",
  " z",
].join("\n");

it("keeps only the hunks a step's ranges touch and counts what it left out", () => {
  const { rows, hidden } = focus(parsePatch(PATCH), [{ start: 2, end: 3 }]);
  const text = rows.map((r) => ("line" in r ? r.line.text : "gap"));
  expect(text).toEqual(["@@ -1,4 +1,5 @@", "a", "b", "B", "C", "d", "e"]);
  expect(hidden).toBe(2);
});

it("cuts a long hunk to the step's lines with a gap row", () => {
  const added = ["@@ -0,0 +1,60 @@", ...Array.from({ length: 60 }, (_, i) => `+line ${i + 1}`)].join("\n");
  const { rows, hidden } = focus(parsePatch(added), [{ start: 10, end: 12 }]);
  const texts = rows.map((r) => ("line" in r ? r.line.text : `gap ${r.gap}`));
  expect(texts).toEqual(["@@ -0,0 +1,60 @@", "gap 6", ...[7, 8, 9, 10, 11, 12, 13, 14, 15].map((n) => `line ${n}`), "gap 45"]);
  expect(hidden).toBe(51);
});

it("falls back to the hunks the reviewer's excerpt quotes, or the whole file", () => {
  expect(focus(parsePatch(PATCH), [], "+ let y = new();").rows).toHaveLength(5);
  expect(focus(parsePatch(PATCH), [], "+ nothing like it").rows).toHaveLength(parsePatch(PATCH).length);
  expect(focus(parsePatch(PATCH), [{ start: 900, end: 901 }]).hidden).toBe(0);
});

it("shows the first rows of a long diff and the rest on request, and the whole file on request", async () => {
  const user = userEvent.setup();
  const long = ["@@ -0,0 +1,100 @@", ...Array.from({ length: 100 }, (_, i) => `+row ${i + 1}`)].join("\n");
  render(<Diff patch={long} />);
  expect(screen.getAllByRole("row")).toHaveLength(40);
  await user.click(screen.getByRole("button", { name: "Show 61 more lines" }));
  expect(screen.getAllByRole("row")).toHaveLength(101);
  cleanup();
  render(<Diff patch={PATCH} ranges={[{ start: 40, end: 40 }]} />);
  expect(screen.getAllByRole("row")).toHaveLength(5);
  await user.click(screen.getByRole("button", { name: "Show the whole file's changes (3 more changed lines)" }));
  expect(screen.getAllByRole("row")).toHaveLength(12);
});
