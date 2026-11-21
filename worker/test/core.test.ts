import { describe, expect, it } from "vitest";
import { isValidId, parseSpec, scanAnchors } from "../src/core";
import checkout from "../../fixtures/shop/spec/checkout.md?raw";
// The same fixture files as crates/core/tests/anchors.rs.
import rust from "../../crates/core/tests/fixtures/anchors/checkout.rs.txt?raw";
import typescript from "../../crates/core/tests/fixtures/anchors/checkout.ts.txt?raw";
import python from "../../crates/core/tests/fixtures/anchors/checkout.py.txt?raw";

// [line, kind, id, class], copied from the Rust tests; keep the two in step.
const rows = (path: string, source: string) => scanAnchors(path, source).map((a) => [a.line, a.kind, a.id, a.class]);

describe("spectrace-core through WASM", () => {
  it("finds the same Rust anchors as the Rust tests", () => {
    expect(rows("crates/server/src/checkout.rs", rust)).toEqual([
      [3, "flow", "checkout.pay", "code"],
      [5, "spec", "checkout.paid", "code"],
      [7, "flow", "checkout.failed", "code"],
      [11, "spec", "checkout.failed", "code"],
      [11, "spec", "checkout.refunded/r2", "code"],
      [21, "spec", "checkout.paid", "test"],
      [25, "flow", "checkout.failed", "test"],
      [29, "spec", "cart.add/r1", "test"],
      [33, "spec", "cart.remove", "code"],
    ]);
  });

  it("finds the same TypeScript anchors as the Rust tests", () => {
    expect(rows("web/src/checkout.ts", typescript)).toEqual([
      [1, "flow", "checkout.pay", "code"],
      [3, "flow", "checkout.paid", "code"],
      [11, "flow", "checkout.refunded", "code"],
      [14, "flow", "checkout.paid", "test"],
      [16, "flow", "checkout.failed", "test"],
      [20, "flow", "cart.add", "test"],
    ]);
  });

  it("finds the same Python anchors as the Rust tests", () => {
    expect(rows("app/checkout.py", python)).toEqual([
      [1, "flow", "checkout.pay", "code"],
      [3, "flow", "checkout.paid", "code"],
      [12, "flow", "checkout.refunded", "code"],
      [17, "flow", "checkout.paid", "test"],
      [23, "flow", "checkout.failed", "test"],
      [28, "flow", "cart.add", "test"],
      [34, "flow", "cart.after", "code"],
    ]);
  });

  it("carries notes, languages and null notes across the boundary", () => {
    const a = scanAnchors("a.rs", rust);
    expect(a[0]).toMatchObject({ language: "rust", note: "charge first, create the order after" });
    expect(a[1]?.note).toBeNull();
    expect(scanAnchors("a.tsx", typescript).every((x) => x.language === "typescript")).toBe(true);
  });

  it("gives no anchors for other file types and validates ids", () => {
    expect(scanAnchors("README.md", rust)).toEqual([]);
    expect(isValidId("checkout.failed/r2")).toBe(true);
    expect(isValidId("Checkout")).toBe(false);
  });

  it("parses the checkout spec like crates/core/tests/spec_parse.rs", () => {
    const { spec, diagnostics } = parseSpec("spec/checkout.md", checkout);
    expect(diagnostics).toEqual([]);
    expect(spec.flow).toBe("checkout");
    expect(spec.title).toMatchObject({ text: "Checkout", id: "checkout", line: 1 });
    expect(spec.diagram?.direction).toBe("LR");
    expect(spec.diagram?.nodes.map((n) => [n.id, n.label, n.line])).toEqual([
      ["cart", "Cart", 5],
      ["details", "Details", 6],
      ["pay", "Pay", 7],
      ["paid", "Paid", 8],
      ["failed", "Declined", 9],
    ]);
    expect(spec.diagram?.edges.map((e) => [e.from, e.label, e.to, e.line])).toEqual([
      ["cart", "start", "details", 11],
      ["details", "pay", "pay", 12],
      ["pay", "ok", "paid", 13],
      ["pay", "declined", "failed", 14],
      ["failed", "retry", "pay", 15],
    ]);
    expect(spec.diagram?.clicks).toHaveLength(5);
    expect(spec.diagram?.clicks[4]).toMatchObject({ node: "failed", target: "checkout.failed" });
    expect(spec.sections.map((s) => s.id)).toContain("checkout.failed");
  });

  it("reports spec errors as diagnostics instead of throwing", () => {
    const { diagnostics } = parseSpec("spec/checkout.md", "no title here\n");
    expect(diagnostics.some((d) => d.code === "S001")).toBe(true);
    expect(diagnostics[0]).toMatchObject({ file: "spec/checkout.md" });
  });
});
