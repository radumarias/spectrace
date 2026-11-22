import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { editSpec, initSync, parseSpec } from "../../../worker/src/wasm/spectrace_core.js";
import { addBox, connect, draftSpec, removeBox, rename, requirementsOf, segmentOf, shapesOf } from "./board";

beforeAll(() => {
  initSync({ module: readFileSync(`${__dirname}/../../../worker/src/wasm/spectrace_core_bg.wasm`) });
});

describe("quick shapes", () => {
  it("reads the hand-written forms", () => {
    const s = shapesOf("flowchart TD\n  a[Cart] --> b[Pay]\n  b -- ok --> c\n  c(Paid)\n  b -->|no| d{Retry?}\n  click a href \"x\"\n  %% note");
    expect(s.boxes).toEqual([
      { id: "a", label: "Cart" },
      { id: "b", label: "Pay" },
      { id: "c", label: "Paid" },
      { id: "d", label: "Retry?" },
    ]);
    expect(s.arrows).toEqual([
      { from: "a", to: "b", label: "" },
      { from: "b", to: "c", label: "ok" },
      { from: "b", to: "d", label: "no" },
    ]);
  });

  it("adds, connects, renames and removes boxes in the text", () => {
    let t = "flowchart LR";
    const a = addBox(t, "Cart");
    const b = addBox(a.text, "Pay", a.id);
    t = connect(rename(b.text, b.id, "Pay now"), b.id, a.id, "back");
    expect(t).toBe("flowchart LR\n  n1[Cart]\n  n2[Pay now]\n  n1 --> n2\n  n2 -->|back| n1");
    expect(removeBox(t, "n1")).toBe("flowchart LR\n  n2[Pay now]");
  });
});

describe("turning a flowchart into requirements", () => {
  it("makes a draft spec that parses with no errors, and takes requirement lines from notes", () => {
    const text = "flowchart LR\n  a[Sign up] --> b[Confirm email]\n  b -->|resend| b\n  b --> c[Welcome!]";
    const { source, ids } = draftSpec("Sign up", "sign_up", text, ["sequenceDiagram\n  A->>B: hi"]);
    expect([...ids.values()]).toEqual(["sign_up", "confirm_email", "welcome"]);
    const parsed = parseSpec("spec/sign_up.md", source);
    expect(parsed.diagnostics.filter((d) => d.code.startsWith("S"))).toEqual([]);
    expect(parsed.spec.sections.map((s) => s.id)).toEqual(["sign_up.sign_up", "sign_up.confirm_email", "sign_up.welcome"]);
    expect(parsed.spec.diagram?.edges.map((e) => `${e.from}-${e.label}-${e.to}`)).toEqual(["sign_up-next-confirm_email", "confirm_email-resend-confirm_email", "confirm_email-next-welcome"]);

    const reqs = requirementsOf(["- Confirm email: WHEN the link is older than 24 hours THE SYSTEM SHALL offer a new one.", "free text"], shapesOf(text).boxes);
    let out = source;
    for (const [box, list] of reqs) for (const r of list) out = editSpec("spec/sign_up.md", out, { op: "addRequirement", node: ids.get(box)!, ...r });
    expect(out).toContain("- WHEN the link is older than 24 hours THE SYSTEM SHALL offer a new one. {#r1}");
    expect(parseSpec("spec/sign_up.md", out).diagnostics.filter((d) => d.code.startsWith("S"))).toEqual([]);
  });

  it("makes valid ids from any label", () => {
    expect(segmentOf("Store front!", "step")).toBe("store_front");
    expect(segmentOf("3D secure", "step")).toBe("step_3d_secure");
    expect(segmentOf("!!!", "step")).toBe("step");
  });
});
