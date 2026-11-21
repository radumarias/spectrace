// Builds the spec index of one repository from its files (T4.4): parses every
// spec file and scans code and tests for anchors with the core WASM build,
// then ties each anchor to the spec its id belongs to. No I/O here; the index
// job reads the files and stores the result.
import { parseSpec, scanAnchors, type Anchor, type Diagnostic, type Spec } from "./core";

const SEGMENT = /^[a-z][a-z0-9_]{0,39}$/;
const SOURCE_EXT = /\.(rs|ts|tsx|mts|cts|py)$/;
/** Folders that hold generated or third-party code, never read for anchors. */
const SKIP_DIRS = new Set(["node_modules", "target", "dist", "build", "vendor", ".git", ".wrangler", "__pycache__"]);
/** Lines kept of an anchored item for the code view. */
const EXCERPT_LINES = 40;

export interface SpecPlace {
  /** Folder that holds the `spec` folder, '' at the top of the repo. */
  root: string;
  /** Folders between `spec/` and the file, '' when the file is directly in `spec/`. */
  area: string;
  /** The file name without `.md`: the flow id. */
  flow: string;
}

/** Where a path sits as a spec file, or null when it is not one: `<root>/spec/<area>/<flow>.md`. */
export function specPlace(path: string): SpecPlace | null {
  const parts = path.split("/");
  const file = parts.pop() ?? "";
  if (!file.endsWith(".md")) return null;
  const flow = file.slice(0, -3);
  if (!SEGMENT.test(flow)) return null; // README.md, CHANGELOG.md and other prose
  const at = parts.lastIndexOf("spec");
  if (at === -1 || parts.some((p) => SKIP_DIRS.has(p))) return null;
  return { root: parts.slice(0, at).join("/"), area: parts.slice(at + 1).join("/"), flow };
}

/** Source files the anchor scanner understands, outside generated folders. */
export function isSourcePath(path: string): boolean {
  return SOURCE_EXT.test(path) && !path.split("/").some((p) => SKIP_DIRS.has(p));
}

/** The files the index job keeps from the repository archive. */
export const wantedPath = (path: string) => specPlace(path) !== null || isSourcePath(path);

export interface IndexedSpec extends SpecPlace {
  path: string;
  title: string;
  source: string;
  /** Null when the file has errors (a diagnostic whose code starts with `S`). */
  model: Spec | null;
  diagnostics: Diagnostic[];
  edges: { from: string; label: string; to: string }[];
  stepCount: number;
  requirementCount: number;
  testedCount: number;
}

export interface IndexedAnchor extends Omit<Anchor, "id"> {
  path: string;
  target: string;
  /** Path of the spec this anchor belongs to, or null when no spec has its flow. */
  specPath: string | null;
  excerpt: string;
}

export interface RepoIndex {
  specs: IndexedSpec[];
  anchors: IndexedAnchor[];
}

const isError = (d: Diagnostic) => d.code.startsWith("S");

/** The anchored item: from the anchor's line to the end of the item it decorates, at most `EXCERPT_LINES`. */
export function excerpt(source: string, line: number, language: Anchor["language"], kind: Anchor["kind"]): string {
  const lines = source.split("\n");
  const start = line - 1;
  if (start < 0 || start >= lines.length) return "";
  // A @flow comment marks one spot inside code: the line itself says it.
  if (kind === "flow") return lines[start]!.trim();
  const out: string[] = [];
  if (language === "python") {
    let base = -1;
    for (let i = start; i < lines.length && out.length < EXCERPT_LINES; i++) {
      const l = lines[i]!;
      const indent = l.length - l.trimStart().length;
      if (base === -1 && /^\s*(async\s+)?(def|class)\s/.test(l)) base = indent;
      else if (base !== -1 && l.trim() && indent <= base) break;
      out.push(l);
    }
  } else {
    let depth = 0;
    let opened = false;
    for (let i = start; i < lines.length && out.length < EXCERPT_LINES; i++) {
      const l = lines[i]!;
      out.push(l);
      for (const ch of l.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\/\/.*$/g, "")) {
        if (ch === "{") {
          depth++;
          opened = true;
        } else if (ch === "}") depth--;
      }
      if (opened && depth <= 0) break;
      if (!opened && /;\s*$/.test(l)) break; // a declaration with no body
    }
  }
  while (out.length && !out[out.length - 1]!.trim()) out.pop();
  return out.join("\n");
}

/** Requirement ids a test anchor covers: itself, or every requirement of a step it names. */
function covered(spec: Spec, target: string): string[] {
  const [step, tag] = target.split("/");
  const section = spec.sections.find((s) => s.id === step);
  if (!section) return [];
  return tag ? (section.requirements.some((r) => r.tag === tag) ? [target] : []) : section.requirements.map((r) => `${section.id}/${r.tag}`);
}

/** Parses and scans the files of one repository. */
export function buildIndex(files: { path: string; text: string }[]): RepoIndex {
  const specs: IndexedSpec[] = [];
  for (const f of files) {
    const place = specPlace(f.path);
    if (!place) continue;
    let model: Spec | null = null;
    let diagnostics: Diagnostic[];
    try {
      const parsed = parseSpec(f.path, f.text);
      diagnostics = parsed.diagnostics;
      model = parsed.diagnostics.some(isError) ? null : parsed.spec;
    } catch (error) {
      diagnostics = [{ code: "S001", file: f.path, line: 1, message: `could not parse: ${String(error)}` }];
    }
    specs.push({
      ...place,
      path: f.path,
      title: model?.title?.text ?? place.flow,
      source: f.text,
      model,
      diagnostics,
      edges: model?.diagram?.edges.map((e) => ({ from: e.from, label: e.label, to: e.to })) ?? [],
      stepCount: model?.sections.length ?? 0,
      requirementCount: model?.sections.reduce((n, s) => n + s.requirements.length, 0) ?? 0,
      testedCount: 0,
    });
  }

  // An anchor belongs to the spec of its flow whose root is the nearest folder above the anchor's file.
  const specFor = (path: string, flow: string): IndexedSpec | null => {
    let best: IndexedSpec | null = null;
    for (const s of specs) {
      if (s.flow !== flow) continue;
      const under = s.root === "" || path === s.root || path.startsWith(`${s.root}/`);
      if (under && (!best || s.root.length > best.root.length)) best = s;
    }
    return best ?? specs.find((s) => s.flow === flow) ?? null;
  };

  const anchors: IndexedAnchor[] = [];
  const tested = new Map<IndexedSpec, Set<string>>();
  for (const f of files) {
    if (!isSourcePath(f.path)) continue;
    let found: Anchor[];
    try {
      found = scanAnchors(f.path, f.text);
    } catch {
      continue;
    }
    for (const a of found) {
      const spec = specFor(f.path, a.id.split(".")[0]!);
      if (spec?.model && a.class === "test" && a.kind === "spec") {
        const set = tested.get(spec) ?? new Set<string>();
        covered(spec.model, a.id).forEach((id) => set.add(id));
        tested.set(spec, set);
      }
      const { id, ...rest } = a;
      anchors.push({ ...rest, path: f.path, target: id, specPath: spec?.path ?? null, excerpt: excerpt(f.text, a.line, a.language, a.kind) });
    }
  }
  for (const [spec, ids] of tested) spec.testedCount = ids.size;
  specs.sort((a, b) => a.path.localeCompare(b.path));
  return { specs, anchors };
}
