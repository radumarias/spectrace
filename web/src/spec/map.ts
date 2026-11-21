// The app map (T6.5): areas and features from the folder layout of the spec
// files. `spec/storefront/checkout.md` is the feature `checkout` in the area
// `storefront`; a spec directly in `spec/` is a feature of the app itself.
// Each node rolls up its specs: requirement coverage, errors, and a status.
// The map is drawn as a Mermaid flowchart by the same diagram as the spec page,
// so a node's `click` line is a mermaid action that selects it.
import type { SpecSummary } from "../api/specs";
import type { StepStatus } from "./model";

export type MapStatus = StepStatus | "bad";

export const MAP_STATUS_LABEL: Record<MapStatus, string> = { ok: "healthy", warn: "partly tested", idle: "no tests", bad: "spec errors" };
export const MAP_STATUS_TONE: Record<MapStatus, "ok" | "warn" | "idle" | "bad"> = { ok: "ok", warn: "warn", idle: "idle", bad: "bad" };

export interface RollUp {
  specs: number;
  steps: number;
  requirements: number;
  tested: number;
  errors: number;
  status: MapStatus;
}

export interface MapNode {
  /** Mermaid node id, `n0`, `n1`, … */
  key: string;
  label: string;
  kind: "area" | "feature";
  /** For an area: its folder path under `spec/`. */
  path: string;
  /** For a feature: the spec to open. */
  specId: string | null;
  sub: string;
  roll: RollUp;
}

export interface MapLevel {
  title: string;
  /** Folder path of this level, '' for the whole app. */
  path: string;
  root: RollUp;
  nodes: MapNode[];
  source: string;
}

export function rollUp(specs: SpecSummary[]): RollUp {
  const r = specs.reduce(
    (a, s) => ({ specs: a.specs + 1, steps: a.steps + s.steps, requirements: a.requirements + s.requirements, tested: a.tested + s.tested, errors: a.errors + s.errors }),
    { specs: 0, steps: 0, requirements: 0, tested: 0, errors: 0 },
  );
  const status: MapStatus = r.errors > 0 ? "bad" : r.requirements > 0 && r.tested === r.requirements ? "ok" : r.tested > 0 ? "warn" : "idle";
  return { ...r, status };
}

/** "checkout" → "Checkout", "store_front" → "Store front". */
export const titleOf = (segment: string) => (segment.charAt(0).toUpperCase() + segment.slice(1)).replace(/[_-]+/g, " ");

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const quote = (t: string) => t.replace(/["[\]|<>]/g, " ").trim() || "untitled";

/** One level of the map: the areas and features directly under `path`. */
export function mapLevel(specs: SpecSummary[], path: string, appName: string): MapLevel {
  const under = specs.filter((s) => path === "" || s.area === path || s.area.startsWith(`${path}/`));
  const areas = new Map<string, SpecSummary[]>();
  const features: SpecSummary[] = [];
  for (const s of under) {
    const rest = path === "" ? s.area : s.area.slice(path.length + 1);
    if (!rest) features.push(s);
    else {
      const first = rest.split("/")[0]!;
      areas.set(first, [...(areas.get(first) ?? []), s]);
    }
  }
  const nodes: MapNode[] = [];
  for (const [name, list] of [...areas].sort(([a], [b]) => a.localeCompare(b))) {
    const roll = rollUp(list);
    nodes.push({ key: `n${nodes.length}`, label: titleOf(name), kind: "area", path: path ? `${path}/${name}` : name, specId: null, sub: plural(roll.specs, "feature", "features"), roll });
  }
  for (const s of [...features].sort((a, b) => a.title.localeCompare(b.title))) {
    const roll = rollUp([s]);
    nodes.push({ key: `n${nodes.length}`, label: s.title, kind: "feature", path: s.area, specId: s.id, sub: plural(s.steps, "step", "steps"), roll });
  }
  const title = path ? titleOf(path.split("/").pop()!) : appName;
  const root = rollUp(under);
  const lines = [
    "flowchart TD",
    `  root["${quote(title)}<br/>${root.specs ? plural(nodes.filter((n) => n.kind === "area").length, "area", "areas") + " · " + plural(root.specs, "feature", "features") : "no specs"}"]`,
    ...nodes.map((n) => `  ${n.key}["${quote(n.label)}<br/>${n.sub}"]`),
    ...nodes.map((n) => `  root --- ${n.key}`),
    ...nodes.map((n) => `  click ${n.key} href "action:step?node=${n.key}" "${n.kind === "area" ? "Show its roll-up" : "Show the feature"}"`),
  ];
  return { title, path, root, nodes, source: `${lines.join("\n")}\n` };
}
