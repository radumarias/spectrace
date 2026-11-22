// Requirements from a discussion (requirements studio, phase 2).
//
// After the user and the coordinator have talked an idea through on a
// whiteboard, one step turns the conversation and the board into a
// requirements set: one spec-format flow per flow on the board (diagram,
// steps, WHEN/SHALL requirements, each with its stable id) and views that
// illustrate those ids: screen mockups in Markdown, other Mermaid diagrams
// and notes. Every flow is checked with spectrace-core's parser, and Claude
// gets one chance to repair what does not parse.
//
// The ids are the spine of everything after this: specs in the repo carry the
// same ids, and code and tests point at them with `#[spec("<id>")]`.
import { MODELS } from "./ai";
import type { BoardContent } from "./board-ops";
import { type AgentBackend, ask } from "./claude-code";
import { parseSpec } from "./core";

export {
  VIEW_KINDS,
  type ViewKind,
  type DraftFlow,
  type DraftView,
  type DraftSet,
  type CheckedFlow,
} from "./requirements-types";
import {
  VIEW_KINDS,
  type ViewKind,
  type DraftFlow,
  type DraftView,
  type DraftSet,
  type CheckedFlow,
} from "./requirements-types";

const SEGMENT = /^[a-z][a-z0-9_]{0,39}$/;
export const MAX_FLOWS = 8;
export const MAX_VIEWS = 40;

export const pathOf = (flow: string) => `spec/${flow}.md`;

/** Parses one flow the way the index will once it is in the repo. */
export function checkFlow(f: DraftFlow): CheckedFlow {
  const path = pathOf(f.flow);
  const parsed = parseSpec(path, f.source);
  const bad = parsed.diagnostics.some((d) => d.code.startsWith("S"));
  return {
    ...f,
    path,
    model: bad ? null : parsed.spec,
    diagnostics: parsed.diagnostics,
  };
}

/** Every step and requirement id the flows define, in order. */
export function idsOf(flows: CheckedFlow[]): string[] {
  const ids: string[] = [];
  for (const f of flows) {
    if (!f.model) continue;
    ids.push(f.flow);
    for (const s of f.model.sections) {
      ids.push(s.id);
      for (const r of s.requirements) ids.push(`${s.id}/${r.tag}`);
    }
  }
  return ids;
}

export function systemPrompt(): string {
  return [
    "You turn a product discussion and its whiteboard sketches into requirements for spectrace, a spec-driven development app.",
    "Answer with exactly one JSON object and nothing else:",
    '{"title":"<short name of the whole set>","flows":[{"flow":"<flow id>","title":"<flow title>","source":"<the whole spec file>"}],"views":[{"of":"<step or requirement id, or null>","kind":"mockup|diagram|note","title":"<short>","text":"<content>"}]}',
    "",
    "A flow is one user or system journey. Its source is a spec file in this exact format (a strict parser checks it):",
    "```",
    "# Checkout {#checkout}",
    "",
    "```mermaid",
    "flowchart LR",
    "  cart[Cart]",
    "  pay[Pay]",
    "  failed[Declined]",
    "  cart -->|checkout| pay",
    "  pay -->|declined| failed",
    "  failed -->|retry| pay",
    "```",
    "",
    "## Cart {#checkout.cart}",
    "",
    "- WHEN the user opens the cart THE SYSTEM SHALL list every item with its price. {#r1}",
    "",
    "## Pay {#checkout.pay}",
    "",
    "- WHEN the user confirms payment THE SYSTEM SHALL charge the card once. {#r1}",
    "",
    "## Declined payment {#checkout.failed}",
    "",
    "- WHEN a payment is declined THE SYSTEM SHALL show the reason. {#r1}",
    "- WHEN a decline goes past the retry limit of 3 THE SYSTEM SHALL cancel the order. {#r2}",
    "",
    "> @flow Why a retry limit? Card networks flag repeated retries as card testing.",
    "```",
    "Rules: ids are lowercase snake_case (a-z, 0-9, _), the flow id is the file name and the title's {#id}. Exactly one mermaid block, a flowchart with LR/RL/TD/TB/BT; only `id[Label]` node lines (each declared once, before use) and labelled edges `a -->|label| b`; labels have no [ ] | \" characters. Every node has exactly one `## Title {#flow.node}` section and every section is a node.",
    "Requirement lines are exactly `- WHEN <trigger> THE SYSTEM SHALL <one behaviour>. {#rN}`, tags r1, r2, ... per step, one behaviour per line, concrete values (numbers, limits, times) written out. Give each step at least one requirement. Use `> @flow <why>` for the reason behind a non-obvious step.",
    "Keep the node ids drawn on the board (they are already the step ids the user saw); only add ids for new steps.",
    "",
    "Views illustrate ids: `of` is a step id (checkout.failed) or a requirement id (checkout.failed/r2), or null for the whole set.",
    "- mockup: a rough screen in Markdown: a `### Screen name` heading, then the visible parts as lists, tables and [Button] labels in brackets, and a line `Shows: <requirement ids>` naming what it satisfies. One mockup per screen the user sees.",
    "- diagram: any other Mermaid diagram (sequenceDiagram, stateDiagram-v2, erDiagram, classDiagram) when it explains something the flow cannot, such as the calls between services or the data.",
    "- note: open questions and assumptions, so nothing the user said is lost.",
    "Cover everything that was agreed in the discussion and drawn on the board, nothing invented beyond small obvious gaps (say so in a note).",
  ].join("\n");
}

export function buildPrompt(o: {
  projectName: string;
  context: string;
  board: BoardContent;
  conversation: { role: string; text: string }[];
  repair?: { flows: CheckedFlow[] };
}): string {
  const lines = [`Project: ${o.projectName}`];
  if (o.context.trim())
    lines.push(`Project context: ${o.context.trim().slice(0, 2000)}`);
  lines.push("", `The whiteboard "${o.board.title}":`);
  for (const b of o.board.blocks) lines.push(`[${b.kind}]`, b.text, "");
  if (o.conversation.length) {
    lines.push("The discussion so far:");
    for (const t of o.conversation)
      lines.push(`${t.role === "user" ? "User" : "Coordinator"}: ${t.text}`);
    lines.push("");
  }
  if (o.repair) {
    lines.push(
      "Your last answer had flows the parser rejected. Fix them and answer again with the whole JSON object; keep every id that already parsed.",
    );
    for (const f of o.repair.flows) {
      const errors = f.diagnostics.filter((d) => d.code.startsWith("S"));
      if (!errors.length) continue;
      lines.push(
        `Flow ${f.flow}:`,
        ...errors.map((d) => `- line ${d.line}: ${d.code} ${d.message}`),
        "Its source was:",
        f.source,
        "",
      );
    }
  }
  lines.push("Answer with the JSON object now.");
  return lines.join("\n");
}

/** The first balanced `{...}` in `text`, or null. */
function firstObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** Claude's answer as a draft set, keeping only well-formed flows and views; null when it is not one. */
export function parseDraft(text: string): DraftSet | null {
  const raw = firstObject(text);
  if (!raw) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const seen = new Set<string>();
  const flows: DraftFlow[] = [];
  for (const f of Array.isArray(o.flows) ? o.flows : []) {
    const r = (f ?? {}) as Record<string, unknown>;
    const flow = str(r.flow)?.trim() ?? "";
    const source = str(r.source) ?? "";
    if (
      !SEGMENT.test(flow) ||
      seen.has(flow) ||
      !source.trim() ||
      source.length > 200_000
    )
      continue;
    seen.add(flow);
    flows.push({
      flow,
      title: (str(r.title)?.trim() || flow).slice(0, 120),
      source: source.endsWith("\n") ? source : `${source}\n`,
    });
    if (flows.length === MAX_FLOWS) break;
  }
  if (!flows.length) return null;
  const views: DraftView[] = [];
  for (const v of Array.isArray(o.views) ? o.views : []) {
    const r = (v ?? {}) as Record<string, unknown>;
    const kind = str(r.kind) as ViewKind | undefined;
    const text = str(r.text) ?? "";
    if (
      !kind ||
      !VIEW_KINDS.includes(kind) ||
      !text.trim() ||
      text.length > 50_000
    )
      continue;
    const of = str(r.of)?.trim() || null;
    views.push({
      id: `v${views.length + 1}`,
      of,
      kind,
      title: (str(r.title)?.trim() || kind).slice(0, 120),
      text,
    });
    if (views.length === MAX_VIEWS) break;
  }
  return {
    title: (str(o.title)?.trim() || flows[0]!.title).slice(0, 120),
    flows,
    views,
  };
}

export interface Drafted {
  title: string;
  flows: CheckedFlow[];
  views: DraftView[];
  ids: string[];
  backend: AgentBackend;
}

export class DraftFailed extends Error {}

/** Drafts a requirements set: one Claude call, and one repair call when a flow does not parse. */
export async function draftRequirements(
  env: Parameters<typeof ask>[0],
  user: { id: string; login: string },
  o: {
    projectName: string;
    context: string;
    board: BoardContent;
    conversation: { role: string; text: string }[];
  },
): Promise<Drafted> {
  const call = (repair?: { flows: CheckedFlow[] }) =>
    ask(env, user, {
      model: MODELS.sonnet,
      maxTokens: 16_000,
      system: systemPrompt(),
      prompt: buildPrompt({ ...o, repair }),
      timeoutMs: 280_000,
    });
  let out = await call();
  let draft = parseDraft(out.text);
  if (!draft) {
    out = await call();
    draft = parseDraft(out.text);
  }
  if (!draft) throw new DraftFailed("Claude did not answer with requirements");
  let flows = draft.flows.map(checkFlow);
  if (flows.some((f) => !f.model)) {
    const again = await call({ flows });
    const fixed = parseDraft(again.text);
    if (fixed) {
      const next = fixed.flows.map(checkFlow);
      // Keep the repair only when it is no worse than the first answer.
      if (
        next.filter((f) => f.model).length >=
        flows.filter((f) => f.model).length
      ) {
        draft = fixed;
        flows = next;
        out = again;
      }
    }
  }
  const ids = idsOf(flows);
  const known = new Set(ids);
  const views = draft.views.map((v) =>
    v.of && !known.has(v.of) ? { ...v, of: null } : v,
  );
  return { title: draft.title, flows, views, ids, backend: out.backend };
}
