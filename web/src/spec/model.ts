// What the spec page derives from a stored spec: each step's requirements and
// whether tests are anchored to them, the code and tests of a step, and the
// Mermaid text of the diagram. Test results are not known yet (no CI results
// per test), so a step is "tested" when every requirement has a test anchored
// to it or to the step.
import type { SpecAnchor, SpecDetail, SpecSection } from "../api/specs";

export type StepStatus = "ok" | "warn" | "idle";

export const STATUS_LABEL: Record<StepStatus, string> = { ok: "tested", warn: "partly tested", idle: "no tests" };
export const STATUS_TONE: Record<StepStatus, "ok" | "warn" | "idle"> = { ok: "ok", warn: "warn", idle: "idle" };

export type Req = { id: string; tag: string; condition: string; response: string; line: number; endLine: number; tested: boolean };

export interface Step {
  /** Node id in the diagram, `failed`. */
  node: string;
  /** Step id, `checkout.failed`. */
  id: string;
  title: string;
  /** The label on the box. */
  label: string;
  line: number;
  reqs: Req[];
  flow: string | null;
  code: SpecAnchor[];
  tests: SpecAnchor[];
  /** `@flow` comments in code pointing at this step. */
  notes: SpecAnchor[];
  status: StepStatus;
}

const ofStep = (a: SpecAnchor, stepId: string) => a.target === stepId || a.target.startsWith(`${stepId}/`);

/** The steps of a spec in section order, with their requirements, anchors and status. */
export function stepsOf(spec: SpecDetail): Step[] {
  const model = spec.model;
  if (!model) return [];
  const labels = new Map((model.diagram?.nodes ?? []).map((n) => [n.id, n.label]));
  return model.sections.map((s: SpecSection) => {
    const anchors = spec.anchors.filter((a) => ofStep(a, s.id));
    const tests = anchors.filter((a) => a.class === "test" && a.kind === "spec");
    const wholeStep = tests.some((t) => t.target === s.id);
    const reqs = s.requirements.map((r) => {
      const id = `${s.id}/${r.tag}`;
      return { id, tag: r.tag, condition: r.condition, response: r.response, line: r.line, endLine: r.end_line, tested: wholeStep || tests.some((t) => t.target === id) };
    });
    const tested = reqs.filter((r) => r.tested).length;
    const status: StepStatus = reqs.length > 0 && tested === reqs.length ? "ok" : tested > 0 ? "warn" : "idle";
    return {
      node: s.node,
      id: s.id,
      title: s.title,
      label: labels.get(s.node) ?? s.title,
      line: s.line,
      reqs,
      flow: s.flow?.text ?? null,
      code: anchors.filter((a) => a.class === "code" && a.kind === "spec"),
      tests,
      notes: anchors.filter((a) => a.kind === "flow"),
      status,
    };
  });
}

/** The text inside the spec's first ```mermaid fence, or null. */
export function mermaidOf(source: string): string | null {
  const m = /^```mermaid[ \t]*\n([\s\S]*?)^```/m.exec(source);
  return m ? m[1]! : null;
}

/** The function or item an excerpt starts, for "Code: `pay` · src/checkout.rs". */
export function itemName(excerpt: string): string | null {
  const m = /\b(?:fn|function|def|class|struct|enum|trait|impl|mod|const)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(excerpt);
  return m ? m[1]! : null;
}

/** A file and line on GitHub, at the indexed branch. */
export function githubLine(spec: Pick<SpecDetail, "repo" | "defaultBranch">, path: string, line?: number): string {
  const p = path.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${spec.repo}/blob/${encodeURIComponent(spec.defaultBranch)}/${p}${line ? `#L${line}` : ""}`;
}

/** `{repo} / {area} / {path}`, the line above the title. */
export function crumbOf(spec: Pick<SpecDetail, "repo" | "path">): string {
  return `${spec.repo} / ${spec.path}`;
}
