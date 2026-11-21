// Specs of a project, as the index job stored them (T4.4): the list for the
// app map and the spec picker, and one spec with its parsed model and the
// code and tests anchored to it, for the spec page.
import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../env";
import { requireUser } from "../auth";
import { AppError, ErrorBody } from "../error";
import { requireProjectOwner } from "./projects";

const ProjectParam = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).openapi({ param: { name: "projectId", in: "path" } });
const SpecParam = z.string().regex(/^[A-Za-z0-9-]{1,64}$/).openapi({ param: { name: "specId", in: "path" } });

// The core's parsed model (crates/core-wasm TS_TYPES), so the OpenAPI document says what `model` holds.
const Span = z.object({ start: z.number().int(), end: z.number().int() }).openapi("SpecSpan");
const Located = z.object({ line: z.number().int(), span: Span });
const Diagnostic = z
  .object({ code: z.string().openapi({ example: "S008" }), file: z.string(), line: z.number().int(), message: z.string() })
  .openapi("SpecDiagnostic");
const Requirement = z
  .object({ tag: z.string(), condition: z.string(), response: z.string(), line: z.number().int(), end_line: z.number().int(), span: Span })
  .openapi("SpecRequirement");
const Section = z
  .object({
    id: z.string().openapi({ example: "checkout.failed" }),
    node: z.string(),
    title: z.string(),
    line: z.number().int(),
    heading: Span,
    span: Span,
    requirements: z.array(Requirement),
    flow: z.object({ text: z.string(), line: z.number().int(), end_line: z.number().int(), span: Span }).nullable(),
  })
  .openapi("SpecSection");
const Diagram = z
  .object({
    direction: z.enum(["LR", "RL", "TD", "TB", "BT"]).nullable(),
    line: z.number().int(),
    span: Span,
    body: Span,
    header: Located.nullable(),
    nodes: z.array(z.object({ id: z.string(), label: z.string(), line: z.number().int(), span: Span })),
    edges: z.array(z.object({ from: z.string(), label: z.string(), to: z.string(), line: z.number().int(), span: Span })),
    clicks: z.array(z.object({ node: z.string(), target: z.string(), line: z.number().int(), span: Span })),
    comments: z.array(z.object({ text: z.string(), line: z.number().int(), span: Span })),
  })
  .openapi("SpecDiagram");
const Model = z
  .object({
    flow: z.string(),
    title: z.object({ text: z.string(), id: z.string(), line: z.number().int(), span: Span }).nullable(),
    diagram: Diagram.nullable(),
    sections: z.array(Section),
    head: Span,
  })
  .openapi("SpecModel");

const SpecSummary = z
  .object({
    id: z.string(),
    repo: z.string().openapi({ example: "acme/shop" }),
    path: z.string().openapi({ example: "spec/checkout.md" }),
    root: z.string().openapi({ description: "Folder holding the `spec` folder, '' at the top of the repo." }),
    area: z.string().openapi({ description: "Folders between `spec/` and the file, '' when flat." }),
    flow: z.string().openapi({ example: "checkout" }),
    title: z.string(),
    steps: z.number().int(),
    requirements: z.number().int(),
    tested: z.number().int().openapi({ description: "Requirements with at least one test anchored to them or to their step." }),
    errors: z.number().int(),
    edges: z.array(z.object({ from: z.string(), label: z.string(), to: z.string() })),
    indexedAt: z.string(),
  })
  .openapi("SpecSummary");

const SpecAnchor = z
  .object({
    path: z.string(),
    line: z.number().int(),
    language: z.enum(["rust", "typescript", "python"]),
    kind: z.enum(["spec", "flow"]),
    class: z.enum(["code", "test"]),
    target: z.string().openapi({ example: "checkout.failed/r2" }),
    note: z.string().nullable(),
    excerpt: z.string(),
  })
  .openapi("SpecAnchor");

const SpecDetail = SpecSummary.extend({
  source: z.string(),
  sha: z.string().nullable(),
  defaultBranch: z.string(),
  model: Model.nullable().openapi({ description: "Null when the file has errors; see diagnostics." }),
  diagnostics: z.array(Diagnostic),
  anchors: z.array(SpecAnchor),
}).openapi("SpecDetail");

const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorBody } } });

const listRoute = createRoute({
  method: "get",
  path: "/api/projects/{projectId}/specs",
  summary: "Specs of a project's repos, by repo and path",
  request: { params: z.object({ projectId: ProjectParam }) },
  responses: {
    200: { description: "Specs", content: { "application/json": { schema: z.array(SpecSummary) } } },
    401: err("Not signed in"),
    404: err("No such project"),
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/api/projects/{projectId}/specs/{specId}",
  summary: "One spec: source, parsed model, diagnostics and the code and tests anchored to it",
  request: { params: z.object({ projectId: ProjectParam, specId: SpecParam }) },
  responses: {
    200: { description: "The spec", content: { "application/json": { schema: SpecDetail } } },
    401: err("Not signed in"),
    404: err("No such project or spec"),
  },
});

interface SpecRow {
  id: string;
  full_name: string;
  default_branch: string;
  path: string;
  root: string;
  area: string;
  flow: string;
  title: string;
  step_count: number;
  requirement_count: number;
  tested_count: number;
  diagnostics: string;
  indexed_at: string;
}

const COLS = `s.id, r.full_name, r.default_branch, s.path, s.root, s.area, s.flow, s.title, s.step_count, s.requirement_count, s.tested_count, s.diagnostics, s.indexed_at`;

function summary(row: SpecRow, edges: { from: string; label: string; to: string }[]): z.infer<typeof SpecSummary> {
  const diagnostics = JSON.parse(row.diagnostics) as { code: string }[];
  return {
    id: row.id,
    repo: row.full_name,
    path: row.path,
    root: row.root,
    area: row.area,
    flow: row.flow,
    title: row.title,
    steps: row.step_count,
    requirements: row.requirement_count,
    tested: row.tested_count,
    errors: diagnostics.filter((d) => d.code.startsWith("S")).length,
    edges,
    indexedAt: row.indexed_at,
  };
}

type EdgeRow = { spec_id: string; from_node: string; label: string; to_node: string };
const edgeOf = (e: EdgeRow) => ({ from: e.from_node, label: e.label, to: e.to_node });

export function registerSpecs(app: OpenAPIHono<AppEnv>) {
  app.openapi(listRoute, async (c) => {
    const user = await requireUser(c);
    const { projectId } = c.req.valid("param");
    await requireProjectOwner(c.env.DB, user.id, projectId);
    const [specs, edges] = await c.env.DB.batch([
      c.env.DB.prepare(`SELECT ${COLS} FROM specs s JOIN project_repos r ON r.id = s.repo_id WHERE s.project_id = ?1 ORDER BY r.full_name, s.path`).bind(projectId),
      c.env.DB.prepare("SELECT e.spec_id, e.from_node, e.label, e.to_node FROM spec_edges e JOIN specs s ON s.id = e.spec_id WHERE s.project_id = ?1").bind(projectId),
    ]);
    const bySpec = new Map<string, EdgeRow[]>();
    for (const e of (edges?.results ?? []) as EdgeRow[]) bySpec.set(e.spec_id, [...(bySpec.get(e.spec_id) ?? []), e]);
    return c.json(((specs?.results ?? []) as SpecRow[]).map((r) => summary(r, (bySpec.get(r.id) ?? []).map(edgeOf))), 200);
  });

  app.openapi(getRoute, async (c) => {
    const user = await requireUser(c);
    const { projectId, specId } = c.req.valid("param");
    await requireProjectOwner(c.env.DB, user.id, projectId);
    const row = await c.env.DB.prepare(
      `SELECT ${COLS}, s.source, s.sha, s.model FROM specs s JOIN project_repos r ON r.id = s.repo_id WHERE s.id = ?1 AND s.project_id = ?2`,
    )
      .bind(specId, projectId)
      .first<SpecRow & { source: string; sha: string | null; model: string | null }>();
    if (!row) throw AppError.notFound(`spec ${specId}`);
    const [edges, anchors] = await c.env.DB.batch([
      c.env.DB.prepare("SELECT spec_id, from_node, label, to_node FROM spec_edges WHERE spec_id = ?1").bind(specId),
      c.env.DB.prepare("SELECT path, line, language, kind, class, target, note, excerpt FROM anchors WHERE spec_id = ?1 ORDER BY class, path, line").bind(specId),
    ]);
    return c.json(
      {
        ...summary(row, ((edges?.results ?? []) as EdgeRow[]).map(edgeOf)),
        source: row.source,
        sha: row.sha,
        defaultBranch: row.default_branch,
        model: row.model ? (JSON.parse(row.model) as z.infer<typeof Model>) : null,
        diagnostics: JSON.parse(row.diagnostics) as z.infer<typeof Diagnostic>[],
        anchors: (anchors?.results ?? []) as z.infer<typeof SpecAnchor>[],
      },
      200,
    );
  });
}
