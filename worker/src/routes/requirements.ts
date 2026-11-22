// Requirements sets (requirements studio, phase 2): drafted by Claude from a
// whiteboard and the coordinator conversation about it, kept as spec-format
// flows with stable ids plus views (mockups, diagrams, notes) of those ids.
import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { requireUser } from "../auth";
import type { BoardBlock } from "../board-ops";
import type { AppEnv } from "../env";
import { AppError, ErrorBody } from "../error";
// spectrace-core (WASM) loads only when a handler runs, so the OpenAPI generator can import this file in Node.
import {
  type DraftFlow,
  type DraftView,
  VIEW_KINDS,
} from "../requirements-types";
import { requireProjectOwner } from "./projects";
import { Diagnostic, Model } from "./specs";

const ProjectParam = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .openapi({ param: { name: "projectId", in: "path" } });
const SetParam = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,64}$/)
  .openapi({ param: { name: "setId", in: "path" } });

const Flow = z
  .object({
    flow: z.string().openapi({ example: "checkout" }),
    title: z.string(),
    path: z
      .string()
      .openapi({
        example: "spec/checkout.md",
        description: "Where the flow goes in a repo as a spec.",
      }),
    source: z.string().openapi({ description: "The flow as a spec file." }),
    model: Model.nullable().openapi({
      description: "Null when the flow has errors; see diagnostics.",
    }),
    diagnostics: z.array(Diagnostic),
  })
  .openapi("RequirementFlow");
const View = z
  .object({
    id: z.string(),
    of: z
      .string()
      .nullable()
      .openapi({
        description:
          "The step or requirement id it illustrates, null for the whole set.",
        example: "checkout.failed/r1",
      }),
    kind: z
      .enum(VIEW_KINDS)
      .openapi({
        description:
          "`mockup` (a screen in Markdown), `diagram` (any Mermaid) or `note` (Markdown).",
      }),
    title: z.string(),
    text: z.string(),
  })
  .openapi("RequirementView");
const SetSummary = z
  .object({
    id: z.string(),
    title: z.string(),
    boardId: z.string().nullable(),
    flows: z.number().int(),
    requirements: z.number().int(),
    updatedAt: z.string(),
  })
  .openapi("RequirementSetSummary");
const RequirementSet = z
  .object({
    id: z.string(),
    title: z.string(),
    boardId: z.string().nullable(),
    flows: z.array(Flow),
    views: z.array(View),
    ids: z
      .array(z.string())
      .openapi({
        description:
          "Every id this set has issued, in order. An id is never reused.",
      }),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("RequirementSet");

const err = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorBody } },
});
const json = <T extends z.ZodType>(description: string, schema: T) => ({
  description,
  content: { "application/json": { schema } },
});
const both = z.object({ projectId: ProjectParam, setId: SetParam });

const listRoute = createRoute({
  method: "get",
  path: "/api/projects/{projectId}/requirements",
  summary: "The project's requirements sets, most recently changed first",
  request: { params: z.object({ projectId: ProjectParam }) },
  responses: {
    200: json("Sets", z.array(SetSummary)),
    401: err("Not signed in"),
    404: err("No such project"),
  },
});
const draftRoute = createRoute({
  method: "post",
  path: "/api/projects/{projectId}/requirements",
  summary:
    "Draft requirements from a whiteboard and your conversation with the coordinator",
  description:
    "Claude turns the board and the discussion into flows in the spec format (steps and WHEN/SHALL requirements with stable ids) and views of those ids: " +
    "screen mockups, other diagrams and notes. Each flow is checked by the spec parser; a flow that does not parse gets one repair round, and keeps its diagnostics if it still fails.",
  request: {
    params: z.object({ projectId: ProjectParam }),
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            boardId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
          }),
        },
      },
    },
  },
  responses: {
    201: json("The drafted set", RequirementSet),
    400: err("Empty board"),
    401: err("Not signed in"),
    404: err("No such project or board"),
    502: err("Claude did not answer with requirements"),
    503: err("Neither Claude Code nor an Anthropic key is configured"),
  },
});
const getRoute = createRoute({
  method: "get",
  path: "/api/projects/{projectId}/requirements/{setId}",
  summary: "One requirements set: its flows (parsed) and views",
  request: { params: both },
  responses: {
    200: json("The set", RequirementSet),
    401: err("Not signed in"),
    404: err("No such project or set"),
  },
});
const deleteRoute = createRoute({
  method: "delete",
  path: "/api/projects/{projectId}/requirements/{setId}",
  summary: "Delete a requirements set",
  request: { params: both },
  responses: {
    204: { description: "Deleted" },
    401: err("Not signed in"),
    404: err("No such project or set"),
  },
});

type Row = {
  id: string;
  title: string;
  board_id: string | null;
  flows: string;
  views: string;
  ids: string;
  created_at: string;
  updated_at: string;
};
const COLS = "id, title, board_id, flows, views, ids, created_at, updated_at";
const parse = <T>(s: string, fallback: T): T => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export const toSet = async (
  r: Row,
): Promise<z.infer<typeof RequirementSet>> => {
  const { checkFlow } = await import("../requirements");
  return {
    id: r.id,
    title: r.title,
    boardId: r.board_id,
    flows: parse<DraftFlow[]>(r.flows, []).map((f) => {
      const c = checkFlow(f);
      return { ...c, model: c.model as z.infer<typeof Model> | null };
    }),
    views: parse<DraftView[]>(r.views, []),
    ids: parse<string[]>(r.ids, []),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
};

export function registerRequirements(app: OpenAPIHono<AppEnv>) {
  app.openapi(listRoute, async (c) => {
    const user = await requireUser(c);
    const { projectId } = c.req.valid("param");
    await requireProjectOwner(c.env.DB, user.id, projectId);
    const { results } = await c.env.DB.prepare(
      `SELECT ${COLS} FROM requirement_sets WHERE project_id = ?1 ORDER BY updated_at DESC`,
    )
      .bind(projectId)
      .all<Row>();
    return c.json(
      results.map((r) => {
        const ids = parse<string[]>(r.ids, []);
        return {
          id: r.id,
          title: r.title,
          boardId: r.board_id,
          flows: parse<unknown[]>(r.flows, []).length,
          requirements: ids.filter((i) => i.includes("/")).length,
          updatedAt: r.updated_at,
        };
      }),
      200,
    );
  });

  app.openapi(draftRoute, async (c) => {
    const user = await requireUser(c);
    const { projectId } = c.req.valid("param");
    const { boardId } = c.req.valid("json");
    await requireProjectOwner(c.env.DB, user.id, projectId);
    const board = await c.env.DB.prepare(
      "SELECT title, blocks FROM boards WHERE id = ?1 AND project_id = ?2",
    )
      .bind(boardId, projectId)
      .first<{ title: string; blocks: string }>();
    if (!board) throw AppError.notFound(`board ${boardId}`);
    const blocks = parse<BoardBlock[]>(board.blocks, []).filter(
      (b) => b.text.trim() && b.text.trim() !== "flowchart LR",
    );
    if (!blocks.length)
      throw AppError.badRequest("the board is empty; sketch the idea first");
    const project = await c.env.DB.prepare(
      "SELECT name, context FROM projects WHERE id = ?1",
    )
      .bind(projectId)
      .first<{ name: string; context: string | null }>();
    const { results } = await c.env.DB.prepare(
      "SELECT role, text FROM coordinator_messages WHERE project_id = ?1 AND user_id = ?2 ORDER BY created_at DESC, rowid DESC LIMIT 40",
    )
      .bind(projectId, user.id)
      .all<{ role: string; text: string }>();
    const { draftRequirements, DraftFailed } = await import("../requirements");
    let drafted;
    try {
      drafted = await draftRequirements(c.env, user, {
        projectName: project?.name ?? "",
        context: project?.context ?? "",
        board: { title: board.title, blocks },
        conversation: results.reverse(),
      });
    } catch (e) {
      if (e instanceof DraftFailed) throw new AppError("upstream", e.message);
      throw e;
    }
    const row = await c.env.DB.prepare(
      `INSERT INTO requirement_sets (id, project_id, board_id, title, flows, views, ids, backend) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) RETURNING ${COLS}`,
    )
      .bind(
        crypto.randomUUID(),
        projectId,
        boardId,
        drafted.title,
        JSON.stringify(
          drafted.flows.map(({ flow, title, source }) => ({
            flow,
            title,
            source,
          })),
        ),
        JSON.stringify(drafted.views),
        JSON.stringify(drafted.ids),
        drafted.backend,
      )
      .first<Row>();
    if (!row)
      throw new AppError("internal", "requirement set insert returned no row");
    return c.json(await toSet(row), 201);
  });

  app.openapi(getRoute, async (c) => {
    const user = await requireUser(c);
    const { projectId, setId } = c.req.valid("param");
    await requireProjectOwner(c.env.DB, user.id, projectId);
    const row = await c.env.DB.prepare(
      `SELECT ${COLS} FROM requirement_sets WHERE id = ?1 AND project_id = ?2`,
    )
      .bind(setId, projectId)
      .first<Row>();
    if (!row) throw AppError.notFound(`requirement set ${setId}`);
    return c.json(await toSet(row), 200);
  });

  app.openapi(deleteRoute, async (c) => {
    const user = await requireUser(c);
    const { projectId, setId } = c.req.valid("param");
    await requireProjectOwner(c.env.DB, user.id, projectId);
    const res = await c.env.DB.prepare(
      "DELETE FROM requirement_sets WHERE id = ?1 AND project_id = ?2",
    )
      .bind(setId, projectId)
      .run();
    if (!res.meta.changes) throw AppError.notFound(`requirement set ${setId}`);
    return c.body(null, 204);
  });
}
