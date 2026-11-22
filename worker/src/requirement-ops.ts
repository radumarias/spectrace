// The coordinator revises a requirements set (requirements studio, phase 3).
//
// On a requirements page the user asks for changes in words ("split r2",
// "add a timeout step", "the mockup needs a cancel button") and the
// coordinator answers with requirement ops. Flow changes go through
// spectrace-core's `editSpec`, which rewrites only the touched lines, so every
// id that is not touched stays exactly as it was. An id that was ever issued
// and then removed is never handed out again: a new requirement that would
// get a retired tag is given the next free one instead, and a new step may
// not take a retired step id.
//
// spectrace-core is loaded only when ops are applied, so the routes (and the
// OpenAPI generator, which runs in Node without the WASM) can import this file.
import type { SpecEdit } from "./core";
import type { DraftFlow, DraftView, ViewKind } from "./requirements-types";
import { VIEW_KINDS } from "./requirements-types";

export type ReqOp =
  | { op: "edit"; flow: string; edit: SpecEdit }
  | { op: "addFlow"; flow: string; title: string; source: string }
  | { op: "removeFlow"; flow: string }
  | { op: "addView"; of: string | null; kind: ViewKind; title: string; text: string }
  | { op: "setView"; id: string; title?: string; text?: string; of?: string | null }
  | { op: "removeView"; id: string }
  | { op: "title"; text: string };

export interface SetContent {
  title: string;
  flows: DraftFlow[];
  views: DraftView[];
  ids: string[];
}

export const MAX_REQ_OPS = 12;
const SEGMENT = /^[a-z][a-z0-9_]{0,39}$/;
const TAG = /^r[1-9][0-9]{0,5}$/;
const VIEW_ID = /^v[0-9]{1,4}$/;
const ID = /^[a-z][a-z0-9_]{0,39}(\.[a-z][a-z0-9_]{0,39})?(\/r[1-9][0-9]{0,5})?$/;

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const text = (v: unknown, max: number) => {
  const s = str(v)?.trim();
  return s && s.length <= max ? s : undefined;
};
const seg = (v: unknown) => {
  const s = str(v)?.trim();
  return s && SEGMENT.test(s) ? s : undefined;
};

/** One SpecEdit from Claude, or null when a field is missing or malformed. */
function cleanEdit(e: unknown): SpecEdit | null {
  if (!e || typeof e !== "object") return null;
  const o = e as Record<string, unknown>;
  const node = seg(o.node);
  const label = text(o.label, 200);
  const from = seg(o.from);
  const to = seg(o.to);
  const tag = str(o.tag)?.trim();
  const condition = text(o.condition, 1000);
  const response = text(o.response, 1000);
  switch (str(o.op)) {
    case "addStep":
      return node && label ? { op: "addStep", node, label, from: from ?? null, edgeLabel: text(o.edgeLabel, 200) ?? null } : null;
    case "removeStep":
      return node ? { op: "removeStep", node } : null;
    case "renameStep":
      return node && label ? { op: "renameStep", node, label } : null;
    case "addEdge":
    case "removeEdge":
      return from && to && label ? { op: str(o.op) as "addEdge" | "removeEdge", from, label, to } : null;
    case "relabelEdge": {
      const newLabel = text(o.newLabel, 200);
      return from && to && label && newLabel ? { op: "relabelEdge", from, label, to, newLabel } : null;
    }
    case "addRequirement":
      return node && condition && response ? { op: "addRequirement", node, condition, response } : null;
    case "setRequirement":
      return node && tag && TAG.test(tag) && condition && response ? { op: "setRequirement", node, tag, condition, response } : null;
    case "removeRequirement":
      return node && tag && TAG.test(tag) ? { op: "removeRequirement", node, tag } : null;
  }
  return null;
}

/** The ops Claude asked for, without anything malformed. */
export function cleanReqOps(raw: unknown): ReqOp[] {
  if (!Array.isArray(raw)) return [];
  const out: ReqOp[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const of = o.of === null ? null : str(o.of)?.trim();
    switch (str(o.op)) {
      case "edit": {
        const flow = seg(o.flow);
        const edit = cleanEdit(o.edit);
        if (flow && edit) out.push({ op: "edit", flow, edit });
        break;
      }
      case "addFlow": {
        const flow = seg(o.flow);
        const source = str(o.source);
        if (flow && source?.trim() && source.length <= 200_000) out.push({ op: "addFlow", flow, title: text(o.title, 120) ?? flow, source: source.endsWith("\n") ? source : `${source}\n` });
        break;
      }
      case "removeFlow": {
        const flow = seg(o.flow);
        if (flow) out.push({ op: "removeFlow", flow });
        break;
      }
      case "addView": {
        const kind = str(o.kind) as ViewKind | undefined;
        const body = str(o.text);
        if (kind && VIEW_KINDS.includes(kind) && body?.trim() && body.length <= 50_000 && (of === null || of === undefined || ID.test(of)))
          out.push({ op: "addView", of: of ?? null, kind, title: text(o.title, 120) ?? kind, text: body });
        break;
      }
      case "setView": {
        const id = str(o.id)?.trim();
        const body = str(o.text);
        const title = text(o.title, 120);
        if (!id || !VIEW_ID.test(id) || (body !== undefined && (!body.trim() || body.length > 50_000))) break;
        if (of !== undefined && of !== null && !ID.test(of)) break;
        if (body === undefined && title === undefined && of === undefined) break;
        out.push({ op: "setView", id, ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { text: body } : {}), ...(of !== undefined ? { of } : {}) });
        break;
      }
      case "removeView": {
        const id = str(o.id)?.trim();
        if (id && VIEW_ID.test(id)) out.push({ op: "removeView", id });
        break;
      }
      case "title": {
        const t = text(o.text, 120);
        if (t) out.push({ op: "title", text: t });
        break;
      }
    }
    if (out.length === MAX_REQ_OPS) break;
  }
  return out;
}

/** Step and requirement ids of one flow's source, or null when it does not parse. */
function flowIds(parse: (path: string, source: string) => { diagnostics: { code: string }[]; spec: { sections: { id: string; requirements: { tag: string }[] }[] } }, f: DraftFlow): string[] | null {
  const p = parse(`spec/${f.flow}.md`, f.source);
  if (p.diagnostics.some((d) => d.code.startsWith("S"))) return null;
  const ids = [f.flow];
  for (const s of p.spec.sections) {
    ids.push(s.id);
    for (const r of s.requirements) ids.push(`${s.id}/${r.tag}`);
  }
  return ids;
}

const editWords = (flow: string, e: SpecEdit, tag?: string): string => {
  switch (e.op) {
    case "addStep":
      return `Added step ${flow}.${e.node}`;
    case "removeStep":
      return `Removed step ${flow}.${e.node}`;
    case "renameStep":
      return `Renamed ${flow}.${e.node} to ${e.label}`;
    case "addEdge":
      return `Connected ${flow}.${e.from} to ${flow}.${e.to} (${e.label})`;
    case "removeEdge":
      return `Removed the arrow ${flow}.${e.from} to ${flow}.${e.to}`;
    case "relabelEdge":
      return `Relabelled ${flow}.${e.from} to ${flow}.${e.to} as ${e.newLabel}`;
    case "addRequirement":
      return `Added ${flow}.${e.node}/${tag ?? "r?"}`;
    case "setRequirement":
      return `Changed ${flow}.${e.node}/${e.tag}`;
    case "removeRequirement":
      return `Removed ${flow}.${e.node}/${e.tag} (its id is retired)`;
  }
};

/** The set after `ops`, what changed in words, and what was skipped and why. */
export async function applyReqOps(set: SetContent, ops: ReqOp[]): Promise<SetContent & { changes: string[]; skipped: string[] }> {
  const { editSpec, parseSpec } = await import("./core");
  const parse = parseSpec as unknown as Parameters<typeof flowIds>[0];
  let title = set.title;
  const flows = set.flows.map((f) => ({ ...f }));
  let views = set.views.map((v) => ({ ...v }));
  const issued = new Set(set.ids);
  const order = [...set.ids];
  const changes: string[] = [];
  const skipped: string[] = [];
  const issue = (ids: string[]) => {
    for (const id of ids)
      if (!issued.has(id)) {
        issued.add(id);
        order.push(id);
      }
  };
  let nextView = Math.max(0, ...views.map((v) => Number(v.id.slice(1)) || 0)) + 1;

  for (const op of ops) {
    if (op.op === "title") {
      if (op.text !== title) {
        title = op.text;
        changes.push(`Renamed the set to ${op.text}`);
      }
    } else if (op.op === "edit") {
      const f = flows.find((x) => x.flow === op.flow);
      if (!f) {
        skipped.push(`no flow ${op.flow}`);
        continue;
      }
      const e = op.edit;
      if (e.op === "addStep" && issued.has(`${f.flow}.${e.node}`)) {
        skipped.push(`step id ${f.flow}.${e.node} was used before; pick a new one`);
        continue;
      }
      const before = new Set(flowIds(parse, f) ?? []);
      let source: string;
      try {
        source = editSpec(`spec/${f.flow}.md`, f.source, e);
      } catch (err) {
        skipped.push(`${op.flow}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      let tag: string | undefined;
      if (e.op === "addRequirement") {
        // The new requirement is the id that was not there before; give it a
        // tag that was never issued if the core picked a retired one.
        const after = flowIds(parse, { ...f, source }) ?? [];
        const added = after.find((id) => !before.has(id) && id.startsWith(`${f.flow}.${e.node}/`));
        tag = added?.split("/")[1];
        if (added && issued.has(added)) {
          const used = new Set([...issued, ...after].filter((id) => id.startsWith(`${f.flow}.${e.node}/r`)).map((id) => Number(id.split("/r")[1])));
          let n = 1;
          while (used.has(n)) n++;
          const fresh = `r${n}`;
          const lines = source.split("\n");
          const head = lines.findIndex((l) => /^## /.test(l) && l.includes(`{#${f.flow}.${e.node}}`));
          let at = -1;
          for (let i = head + 1; head >= 0 && i < lines.length && !/^## /.test(lines[i]!); i++) if (lines[i]!.includes(`{#${tag}}`)) at = i;
          if (at >= 0) {
            lines[at] = lines[at]!.replace(`{#${tag}}`, `{#${fresh}}`);
            source = lines.join("\n");
            tag = fresh;
          }
        }
      }
      f.source = source;
      issue(flowIds(parse, f) ?? []);
      changes.push(editWords(f.flow, e, tag));
    } else if (op.op === "addFlow") {
      if (flows.some((x) => x.flow === op.flow) || issued.has(op.flow)) {
        skipped.push(`flow id ${op.flow} is taken or was used before`);
        continue;
      }
      const f = { flow: op.flow, title: op.title, source: op.source };
      const ids = flowIds(parse, f);
      if (!ids) {
        skipped.push(`flow ${op.flow} does not parse`);
        continue;
      }
      const reused = ids.filter((id) => issued.has(id));
      if (reused.length) {
        skipped.push(`flow ${op.flow} reuses retired ids ${reused.join(", ")}`);
        continue;
      }
      flows.push(f);
      issue(ids);
      changes.push(`Added the flow ${op.title} (${op.flow})`);
    } else if (op.op === "removeFlow") {
      const i = flows.findIndex((x) => x.flow === op.flow);
      if (i < 0) {
        skipped.push(`no flow ${op.flow}`);
        continue;
      }
      flows.splice(i, 1);
      changes.push(`Removed the flow ${op.flow} (its ids are retired)`);
    } else if (op.op === "addView") {
      const v = { id: `v${nextView++}`, of: op.of, kind: op.kind, title: op.title, text: op.text };
      views.push(v);
      changes.push(`Added the ${op.kind} ${op.title}`);
    } else if (op.op === "setView") {
      const v = views.find((x) => x.id === op.id);
      if (!v) {
        skipped.push(`no view ${op.id}`);
        continue;
      }
      if (op.title !== undefined) v.title = op.title;
      if (op.text !== undefined) v.text = op.text;
      if (op.of !== undefined) v.of = op.of;
      changes.push(`Changed the ${v.kind} ${v.title}`);
    } else {
      const v = views.find((x) => x.id === op.id);
      if (!v) {
        skipped.push(`no view ${op.id}`);
        continue;
      }
      views = views.filter((x) => x.id !== op.id);
      changes.push(`Removed the ${v.kind} ${v.title}`);
    }
  }
  return { title, flows, views, ids: order, changes, skipped };
}

/** The set as the coordinator reads it in its prompt. */
export function setText(id: string, set: SetContent, limit = 40_000): string {
  const lines = [`The requirements set "${set.title}" (set id=${id}).`, "Flows (spec files):"];
  for (const f of set.flows) lines.push(`--- flow ${f.flow}: ${f.title}`, f.source);
  lines.push("Views:");
  if (!set.views.length) lines.push("(none)");
  for (const v of set.views) lines.push(`--- [${v.id}] ${v.kind} "${v.title}" of ${v.of ?? "the whole set"}`, v.text);
  const live = new Set<string>();
  for (const f of set.flows) for (const m of f.source.matchAll(/\{#([a-z][a-z0-9_.]*)\}/g)) live.add(m[1]!);
  const retired = set.ids.filter((i) => !i.includes("/") && !live.has(i));
  if (retired.length) lines.push(`Retired step and flow ids (never use again): ${retired.join(", ")}`);
  const text = lines.join("\n");
  return text.length > limit ? `${text.slice(0, limit)}\n(cut)` : text;
}
