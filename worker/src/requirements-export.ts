// A requirements set as files in a repository (requirements studio, phase 4).
//
// Each flow becomes its spec file, `spec/<flow>.md`, with the same ids it has
// in the app. The mockups, diagrams and notes of a flow go next to it in
// `spec/<flow>.views.md`: plain Markdown with Mermaid blocks, which devpage
// renders and which the spec index skips (its name is not a flow id). The pull
// request lists every id, so the code and tests can point at them with
// `#[spec("<id>")]`.
import type { CheckedFlow, DraftView } from "./requirements-types";

export interface ExportFile {
  path: string;
  source: string;
}

const KIND = { mockup: "mockup", diagram: "diagram", note: "note" } as const;

function viewBlock(v: DraftView): string[] {
  const head = `## ${v.title} (${KIND[v.kind]}${v.of ? ` of ${v.of}` : ""})`;
  if (v.kind === "diagram") return [head, "", "```mermaid", v.text.trimEnd(), "```", ""];
  // Headings inside a mockup or note sit under the view's own heading: the highest becomes ###.
  const text = v.text.trimEnd();
  const levels = [...text.matchAll(/^(#{1,6}) /gm)].map((m) => m[1]!.length);
  const shift = levels.length ? Math.max(0, 3 - Math.min(...levels)) : 0;
  const body = text.replace(/^(#{1,6}) /gm, (_, h: string) => `${"#".repeat(Math.min(6, h.length + shift))} `);
  return [head, "", body, ""];
}

/** The views file of one flow, or null when it has no views. `loose` are views of the whole set. */
export function viewsFile(flow: CheckedFlow, views: DraftView[], loose: DraftView[] = []): ExportFile | null {
  const own = views.filter((v) => v.of === flow.flow || v.of?.startsWith(`${flow.flow}.`));
  if (!own.length && !loose.length) return null;
  const lines = [`# ${flow.title}: mockups, diagrams and notes`, "", `Views of the requirements in [${flow.flow}.md](${flow.flow}.md). The ids are the ones in the spec.`, ""];
  for (const v of own) lines.push(...viewBlock(v));
  if (loose.length) {
    lines.push("## Also discussed", "");
    for (const v of loose) lines.push(...viewBlock(v).map((l) => (l.startsWith("## ") ? `#${l}` : l)));
  }
  return { path: `spec/${flow.flow}.views.md`, source: `${lines.join("\n").trimEnd()}\n` };
}

/** Every file of the set: each flow's spec and its views. Views of the whole set go with the first flow. */
export function exportFiles(flows: CheckedFlow[], views: DraftView[]): ExportFile[] {
  const files: ExportFile[] = [];
  const flowIds = new Set(flows.map((f) => f.flow));
  const loose = views.filter((v) => !v.of || ![...flowIds].some((f) => v.of === f || v.of!.startsWith(`${f}.`)));
  flows.forEach((f, i) => {
    files.push({ path: f.path, source: f.source });
    const vf = viewsFile(f, views, i === 0 ? loose : []);
    if (vf) files.push(vf);
  });
  return files;
}

/** The pull request's description: what it adds and every id, as a checklist for anchoring code and tests. */
export function pullBody(o: { title: string; login: string; flows: CheckedFlow[]; files: ExportFile[]; link?: string }): string {
  const lines = [
    `Requirements **${o.title}**, talked through with the coordinator on a whiteboard and drafted in spectrace by @${o.login}.`,
    ...(o.link ? ["", `Open them in spectrace: ${o.link}`] : []),
    "",
    "Files:",
    ...o.files.map((f) => `- \`${f.path}\``),
    "",
    'Anchor the code that implements a step with `#[spec("<step id>")]` and each test with `#[spec("<requirement id>")]`; the spec page then shows which ids are tested.',
  ];
  for (const f of o.flows) {
    if (!f.model) continue;
    lines.push("", `### ${f.title} (\`${f.flow}\`)`);
    for (const s of f.model.sections) {
      lines.push(`- [ ] \`${s.id}\` ${s.title}`);
      for (const r of s.requirements) lines.push(`  - [ ] \`${s.id}/${r.tag}\` WHEN ${r.condition} THE SYSTEM SHALL ${r.response}.`);
    }
  }
  return lines.join("\n");
}
