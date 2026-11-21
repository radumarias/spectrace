import { describe, expect, it } from "vitest";
import { buildIndex, excerpt, isSourcePath, specPlace } from "../src/specs";
import { readTarGz } from "../src/tarball";
import { SHOP } from "./fixtures";
import { tarGz } from "./tar";

const stream = async (files: Record<string, string>) => new Response(await tarGz(files)).body!;
const limits = { maxFileBytes: 1024, maxTotalBytes: 1 << 20 };

describe("readTarGz", () => {
  it("keeps the wanted files, under the archive's top folder, long paths included", async () => {
    const long = `${"deep/".repeat(30)}spec/checkout.md`;
    const out = await readTarGz(await stream({ "a.md": "A", "b.txt": "B", [long]: "L" }), (p) => p.endsWith(".md"), limits);
    expect(out).toEqual({ files: [{ path: "a.md", text: "A" }, { path: long, text: "L" }], truncated: false });
  });

  it("skips files over the size limit and stops at the total limit", async () => {
    const big = "x".repeat(2000);
    const skipped = await readTarGz(await stream({ "big.md": big, "ok.md": "ok" }), () => true, limits);
    expect(skipped.files.map((f) => f.path)).toEqual(["ok.md"]);
    const capped = await readTarGz(await stream({ "a.md": "aaaa", "b.md": "bbbb" }), () => true, { maxFileBytes: 100, maxTotalBytes: 6 });
    expect(capped).toEqual({ files: [{ path: "a.md", text: "aaaa" }], truncated: true });
  });
});

describe("spec files", () => {
  it("are Markdown files with a flow id for a name, under a spec folder", () => {
    expect(specPlace("spec/checkout.md")).toEqual({ root: "", area: "", flow: "checkout" });
    expect(specPlace("fixtures/shop/spec/checkout.md")).toEqual({ root: "fixtures/shop", area: "", flow: "checkout" });
    expect(specPlace("spec/storefront/cart/checkout.md")).toEqual({ root: "", area: "storefront/cart", flow: "checkout" });
    for (const p of ["spec/README.md", "docs/checkout.md", "spec/Check-out.md", "node_modules/a/spec/checkout.md", "spec/checkout.txt"]) expect(specPlace(p)).toBeNull();
    expect(isSourcePath("src/checkout.rs")).toBe(true);
    expect(isSourcePath("web/src/a.tsx")).toBe(true);
    expect(isSourcePath("target/debug/build.rs")).toBe(false);
    expect(isSourcePath("README.md")).toBe(false);
  });
});

describe("excerpt", () => {
  it("takes a Rust item to its closing brace, ignoring braces in strings", () => {
    const src = ['#[spec("a.b")]', "fn x() {", '    let s = "}";', "    if y { z() }", "}", "fn other() {}"].join("\n");
    expect(excerpt(src, 1, "rust", "spec")).toBe(src.split("\n").slice(0, 5).join("\n"));
  });
  it("takes a Python function by its indentation, and a @flow comment as one line", () => {
    const src = ["# spec: a.b", "def f():", "    return 1", "", "def g():", "    pass"].join("\n");
    expect(excerpt(src, 1, "python", "spec")).toBe("# spec: a.b\ndef f():\n    return 1");
    expect(excerpt("fn a() {\n    // @flow a.b: why\n}", 2, "rust", "flow")).toBe("// @flow a.b: why");
  });
});

describe("buildIndex", () => {
  it("ties anchors to the nearest spec root with that flow", () => {
    const files = [
      { path: "spec/checkout.md", text: SHOP["spec/checkout.md"]! },
      { path: "fixtures/shop/spec/checkout.md", text: SHOP["spec/checkout.md"]! },
      { path: "fixtures/shop/tests/checkout.rs", text: SHOP["tests/checkout.rs"]! },
      { path: "tests/other.rs", text: '#[test]\n#[spec("checkout.cart/r1")]\nfn t() {}\n' },
      { path: "tests/lost.rs", text: '#[test]\n#[spec("orders.list/r1")]\nfn t() {}\n' },
    ];
    const index = buildIndex(files);
    expect(index.specs.map((s) => [s.path, s.testedCount])).toEqual([
      ["fixtures/shop/spec/checkout.md", 7],
      ["spec/checkout.md", 1],
    ]);
    expect(index.anchors.find((a) => a.path === "tests/lost.rs")?.specPath).toBeNull();
  });
});
