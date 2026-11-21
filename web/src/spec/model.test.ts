import { describe, expect, it, vi } from "vitest";
import SPEC from "../../e2e/spec-checkout.json";
import type { SpecDetail } from "../api/specs";
import { mount, nodeIdOf, parseClicks, register } from "./actions";
import { githubLine, itemName, mermaidOf, stepsOf } from "./model";

const spec = SPEC as unknown as SpecDetail;

describe("stepsOf", () => {
  it("gives each step its requirements, tests, code and status", () => {
    const steps = stepsOf(spec);
    expect(steps.map((s) => [s.node, s.status])).toEqual([
      ["cart", "ok"],
      ["details", "idle"],
      ["pay", "ok"],
      ["failed", "ok"],
      ["paid", "ok"],
    ]);
    const pay = steps.find((s) => s.node === "pay")!;
    expect(pay.label).toBe("Pay");
    expect(pay.reqs.map((r) => [r.id, r.tested])).toEqual([["checkout.pay/r1", true], ["checkout.pay/r2", true]]);
    expect(pay.code.map((a) => itemName(a.excerpt))).toEqual(["pay"]);
    expect(pay.tests.map((a) => itemName(a.excerpt))).toEqual(["charges_once", "timeout_is_idempotent"]);
    expect(steps.find((s) => s.node === "failed")!.flow).toMatch(/card testing/);
  });
  it("is empty for a spec with errors", () => expect(stepsOf({ ...spec, model: null })).toEqual([]));
});

describe("helpers", () => {
  it("reads the mermaid fence and links to GitHub", () => {
    expect(mermaidOf(spec.source)?.startsWith("flowchart LR\n")).toBe(true);
    expect(mermaidOf("# x\n")).toBeNull();
    expect(githubLine(spec, "src/a b.rs", 3)).toBe("https://github.com/acme/shop/blob/main/src/a%20b.rs#L3");
  });
});

describe("mermaid-actions", () => {
  it("parses action: click lines only", () => {
    const src = 'flowchart LR\n  a[A] --> b[B]\n  click a href "action:copy?text=x" "Copy"\n  click b href "https://x.test"';
    expect(parseClicks(src)).toEqual({ a: { href: "action:copy?text=x", tooltip: "Copy" } });
  });
  it("runs an action: link on click, and hands other links to the host", () => {
    document.body.innerHTML = `<div id="root"><svg><g data-id="a"><a href="action:toggle?class=checked"><rect/></a></g><g data-id="b"><a href="spec://checkout.b"><rect/></a></g><g data-id="c"><a href="action:step?id=checkout.c"><rect/></a></g></svg></div>`;
    const root = document.getElementById("root")!;
    const onLink = vi.fn();
    const select = vi.fn();
    const { destroy } = mount(root, { onLink, select, toast: () => {} });
    root.querySelector('[data-id="a"] rect')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(root.querySelector('[data-id="a"]')!.classList.contains("checked")).toBe(true);
    root.querySelector('[data-id="b"] rect')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onLink).toHaveBeenCalledWith("spec://checkout.b", expect.anything(), expect.anything());
    root.querySelector('[data-id="c"] rect')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(select).toHaveBeenCalledWith("c");
    expect(nodeIdOf(root.querySelector('[data-id="c"] rect'))?.id).toBe("c");
    destroy();
  });
  it("lets a host add its own action and reports unknown ones", () => {
    const seen: string[] = [];
    register("hello", (p) => seen.push(p.get("to") ?? ""));
    document.body.innerHTML = `<div id="root"><a href="action:hello?to=radu">x</a><a href="action:nope">y</a></div>`;
    const root = document.getElementById("root")!;
    const toast = vi.fn();
    mount(root, { toast });
    root.querySelectorAll("a")[0]!.click();
    root.querySelectorAll("a")[1]!.click();
    expect(seen).toEqual(["radu"]);
    expect(toast).toHaveBeenCalledWith("Unknown action: nope");
  });
});
