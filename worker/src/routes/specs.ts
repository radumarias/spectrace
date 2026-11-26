// Specs of a project, as the index job stored them (T4.4): the list for the
// app map and the spec picker, and one spec with its parsed model and the
// code and tests anchored to it, for the spec page.
import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { devpageOn } from "../devpage";
import type { AppEnv } from "../env";
import { requireUser } from "../auth";
import { AppError, ErrorBody } from "../error";
import { requireProjectOwner } from "./projects";
import { repoClient, type RepoClient } from "../git";

const ProjectParam = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).openapi({ param: { name: "projectId", in: "path" } });
const SpecParam = z.string().regex(/^[A-Za-z0-9-]{1,64}$/).openapi({ param: { name: "specId", in: "path" } });

// The core's parsed model (crates/core-wasm TS_TYPES), so the OpenAPI document says what `model` holds.
const Span = z.object({ start: z.number().int(), end: z.number().int() }).openapi("SpecSpan");
const Located = z.object({ line: z.number().int(), span: Span });
export const Diagnostic = z
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
    actions: z.array(
      z.object({
        node: z.string(),
        href: z.string(),
        name: z.string(),
        tooltip: z.string().nullable(),
        line: z.number().int(),
        span: Span,
      }),
    ),
    comments: z.array(z.object({ text: z.string(), line: z.number().int(), span: Span })),
  })
  .openapi("SpecDiagram");
export const Model = z
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
  devpage: z
    .object({
      id: z.string(),
      version: z.number().int(),
      url: z.string().openapi({ example: "/d/6f1c2a9e-0000-4000-8000-000000000000/" }),
    })
    .nullable()
    .openapi({ description: "The spec as devpage server renders it, on this origin; null while devpage is off or has not published it." }),
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

const SpecChange = z
  .object({
    source: z.string().min(1).max(500_000).openapi({ description: "The whole spec file as edited." }),
    summary: z.array(z.string().max(300)).max(100).openapi({ description: "One line per change, for the pull request.", example: ["Renamed Declined to Payment declined"] }),
  })
  .openapi("SpecChange");

export const SpecChangeOpened = z
  .object({
    number: z.number().int(),
    url: z.string().openapi({ example: "https://github.com/acme/shop/pull/7" }),
    branch: z.string().openapi({ example: "spectrace/spec-checkout-m3k2x1" }),
  })
  .openapi("SpecChangeOpened");

const changeRoute = createRoute({
  method: "post",
  path: "/api/projects/{projectId}/specs/{specId}/changes",
  summary: "Save an edited spec: commit it on a new branch and open a pull request",
  request: {
    params: z.object({ projectId: ProjectParam, specId: SpecParam }),
    body: { content: { "application/json": { schema: SpecChange } }, required: true },
  },
  responses: {
    201: { description: "The pull request", content: { "application/json": { schema: SpecChangeOpened } } },
    400: err("Nothing changed, or the edited spec has errors"),
    401: err("Not signed in"),
    404: err("No such project or spec"),
    409: err("The spec changed on the host since it was indexed, or the host refused"),
  },
});

/** Commits new files on a new branch from the default branch and opens one pull request for them. Refuses (409) when a file already exists there. */
export async function openFilesPull(
  env: AppEnv["Bindings"],
  projectId: string,
  o: { repo: string; defaultBranch: string; branch: string; files: { path: string; source: string }[]; message: string; title: string; body: string },
): Promise<z.infer<typeof SpecChangeOpened>> {
  const client = await repoClient(env, projectId, o.repo, "write");
  for (const f of o.files) {
    if (await client.readFile(f.path, o.defaultBranch)) throw new AppError("conflict", `conflict: ${f.path} already exists on ${o.defaultBranch}`);
  }
  const base = await client.branchHead(o.defaultBranch);
  await client.createBranch(o.branch, base);
  for (const f of o.files) {
    await client.putFile({ path: f.path, branch: o.branch, message: `${o.message}: ${f.path}`, text: f.source, sha: null });
  }
  const pr = await client.openPull({ title: o.title, head: o.branch, base: o.defaultBranch, body: o.body });
  return { ...pr, branch: o.branch };
}

/** Commits `source` to `path` on a new branch from the default branch and opens a pull request for it. */
async function openSpecPull(
  client: RepoClient,
  login: string,
  o: { defaultBranch: string; path: string; flow: string; title: string; source: string; fileSha: string | null; summary: string[]; verb: "Edit" | "Add" },
): Promise<z.infer<typeof SpecChangeOpened>> {
  const base = await client.branchHead(o.defaultBranch);
  const branch = `spectrace/spec-${o.flow}-${Date.now().toString(36)}`;
  await client.createBranch(branch, base);
  const lines = o.summary.length ? o.summary : [o.verb === "Add" ? "Added the spec" : "Edited the spec"];
  await client.putFile({ path: o.path, branch, message: `${o.verb} ${o.path}\n\n${lines.map((l) => `- ${l}`).join("\n")}`, text: o.source, sha: o.fileSha });
  const pr = await client.openPull({
    title: o.verb === "Add" ? `Spec: add ${o.title || o.flow}` : `Spec: ${o.title || o.flow} (${lines.length} ${lines.length === 1 ? "change" : "changes"})`,
    head: branch,
    base: o.defaultBranch,
    body: `${o.verb === "Add" ? "Drafted on a whiteboard and edited" : "Edited"} in the spectrace diagram editor by @${login}.\n\n${lines.map((l) => `- ${l}`).join("\n")}`,
  });
  return { ...pr, branch };
}

const NewSpec = z
  .object({
    repoId: z.string().min(1).max(64),
    path: z
      .string()
      .regex(/^(?:[A-Za-z0-9_.-]+\/)*spec\/(?:[a-z][a-z0-9_]*\/)*[a-z][a-z0-9_]{0,39}\.md$/)
      .openapi({ example: "spec/sign_up.md", description: "Under a `spec/` folder; the file name is the flow id." }),
    source: z.string().min(1).max(500_000),
    summary: z.array(z.string().max(300)).max(100),
  })
  .openapi("NewSpec");

const newRoute = createRoute({
  method: "post",
  path: "/api/projects/{projectId}/specs/new",
  summary: "Add a new spec file (a whiteboard draft): commit it on a new branch and open a pull request",
  request: { params: z.object({ projectId: ProjectParam }), body: { content: { "application/json": { schema: NewSpec } }, required: true } },
  responses: {
    201: { description: "The pull request", content: { "application/json": { schema: SpecChangeOpened } } },
    400: err("The spec has errors"),
    401: err("Not signed in"),
    404: err("No such project or repo"),
    409: err("The file already exists, or the host refused"),
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
      `SELECT ${COLS}, s.source, s.sha, s.model, s.devpage_id, s.devpage_version FROM specs s JOIN project_repos r ON r.id = s.repo_id WHERE s.id = ?1 AND s.project_id = ?2`,
    )
      .bind(specId, projectId)
      .first<SpecRow & { source: string; sha: string | null; model: string | null; devpage_id: string | null; devpage_version: number | null }>();
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
        devpage: row.devpage_id && devpageOn(c.env) ? { id: row.devpage_id, version: row.devpage_version ?? 1, url: `/d/${row.devpage_id}/` } : null,
      },
      200,
    );
  });

  app.openapi(changeRoute, async (c) => {
    const user = await requireUser(c);
    const { projectId, specId } = c.req.valid("param");
    const { source, summary } = c.req.valid("json");
    await requireProjectOwner(c.env.DB, user.id, projectId);
    const row = await c.env.DB.prepare(
      "SELECT s.path, s.flow, s.title, s.source, r.full_name, r.default_branch FROM specs s JOIN project_repos r ON r.id = s.repo_id WHERE s.id = ?1 AND s.project_id = ?2",
    )
      .bind(specId, projectId)
      .first<{ path: string; flow: string; title: string; source: string; full_name: string; default_branch: string }>();
    if (!row) throw AppError.notFound(`spec ${specId}`);
    if (source === row.source) throw AppError.badRequest("nothing changed");
    // Loaded here, not at the top: the OpenAPI script (Node) imports this file and has no WASM.
    const { parseSpec } = await import("../core");
    const errors = parseSpec(row.path, source).diagnostics.filter((d) => d.code.startsWith("S"));
    if (errors.length) throw AppError.badRequest(`the edited spec has errors: ${errors.map((d) => `${d.code} line ${d.line} ${d.message}`).join("; ")}`);

    const client = await repoClient(c.env, projectId, row.full_name, "write");
    const file = await client.readFile(row.path, row.default_branch);
    if (!file) throw new AppError("conflict", `conflict: ${row.path} is not on ${row.default_branch} any more; re-index the repo`);
    if (file.text !== row.source) {
      throw new AppError("conflict", `conflict: ${row.path} changed on ${row.default_branch} since it was indexed; re-index the repo and edit again`);
    }
    const opened = await openSpecPull(client, user.login, { defaultBranch: row.default_branch, path: row.path, flow: row.flow, title: row.title, source, fileSha: file.sha, summary, verb: "Edit" });
    return c.json(opened, 201);
  });

  app.openapi(newRoute, async (c) => {
    const user = await requireUser(c);
    const { projectId } = c.req.valid("param");
    const { repoId, path: file, source, summary } = c.req.valid("json");
    await requireProjectOwner(c.env.DB, user.id, projectId);
    const repo = await c.env.DB.prepare("SELECT full_name, default_branch FROM project_repos WHERE id = ?1 AND project_id = ?2")
      .bind(repoId, projectId)
      .first<{ full_name: string; default_branch: string }>();
    if (!repo) throw AppError.notFound(`repo ${repoId}`);
    const { parseSpec } = await import("../core");
    const parsed = parseSpec(file, source);
    const errors = parsed.diagnostics.filter((d) => d.code.startsWith("S"));
    if (errors.length) throw AppError.badRequest(`the spec has errors: ${errors.map((d) => `${d.code} line ${d.line} ${d.message}`).join("; ")}`);
    const client = await repoClient(c.env, projectId, repo.full_name, "write");
    if (await client.readFile(file, repo.default_branch)) throw new AppError("conflict", `conflict: ${file} already exists on ${repo.default_branch}`);
    const flow = parsed.spec.flow;
    const title = parsed.spec.title?.text ?? flow;
    const opened = await openSpecPull(client, user.login, { defaultBranch: repo.default_branch, path: file, flow, title, source, fileSha: null, summary, verb: "Add" });
    return c.json(opened, 201);
  });
}
