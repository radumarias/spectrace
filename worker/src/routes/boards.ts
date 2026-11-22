// Whiteboards (T5.7): a project's boards of sketches. A board is a title and
// an ordered list of blocks, each a Markdown note or a Mermaid diagram whose
// text is its source. The web app draws them and turns a flowchart into a
// draft spec; the Worker only keeps them.
import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { requireUser } from "../auth";
import type { AppEnv } from "../env";
import { AppError, ErrorBody } from "../error";
import { requireProjectOwner } from "./projects";

const ProjectParam = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).openapi({ param: { name: "projectId", in: "path" } });
const BoardParam = z.string().regex(/^[A-Za-z0-9-]{1,64}$/).openapi({ param: { name: "boardId", in: "path" } });

const Block = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    kind: z.enum(["note", "mermaid"]),
    text: z.string().max(50_000),
  })
  .openapi("BoardBlock");

const BoardSummary = z
  .object({ id: z.string(), title: z.string(), blocks: z.number().int(), updatedAt: z.string() })
  .openapi("BoardSummary");
const Board = z
  .object({ id: z.string(), title: z.string(), blocks: z.array(Block), createdAt: z.string(), updatedAt: z.string() })
  .openapi("Board");
const BoardInput = z
  .object({ title: z.string().trim().min(1).max(120), blocks: z.array(Block).max(100) })
  .openapi("BoardInput");

const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorBody } } });
const json = <T extends z.ZodType>(description: string, schema: T) => ({ description, content: { "application/json": { schema } } });
const both = z.object({ projectId: ProjectParam, boardId: BoardParam });

const listRoute = createRoute({
  method: "get",
  path: "/api/projects/{projectId}/boards",
  summary: "The project's whiteboards, most recently changed first",
  request: { params: z.object({ projectId: ProjectParam }) },
  responses: { 200: json("Boards", z.array(BoardSummary)), 401: err("Not signed in"), 404: err("No such project") },
});
const createBoardRoute = createRoute({
  method: "post",
  path: "/api/projects/{projectId}/boards",
  summary: "Start a whiteboard",
  request: { params: z.object({ projectId: ProjectParam }), body: { content: { "application/json": { schema: BoardInput } }, required: true } },
  responses: { 201: json("The board", Board), 400: err("Bad board"), 401: err("Not signed in"), 404: err("No such project") },
});
const getRoute = createRoute({
  method: "get",
  path: "/api/projects/{projectId}/boards/{boardId}",
  summary: "One whiteboard with its blocks",
  request: { params: both },
  responses: { 200: json("The board", Board), 401: err("Not signed in"), 404: err("No such project or board") },
});
const putRoute = createRoute({
  method: "put",
  path: "/api/projects/{projectId}/boards/{boardId}",
  summary: "Replace a whiteboard's title and blocks",
  request: { params: both, body: { content: { "application/json": { schema: BoardInput } }, required: true } },
  responses: { 200: json("The board", Board), 400: err("Bad board"), 401: err("Not signed in"), 404: err("No such project or board") },
});
const deleteRoute = createRoute({
  method: "delete",
  path: "/api/projects/{projectId}/boards/{boardId}",
  summary: "Delete a whiteboard",
  request: { params: both },
  responses: { 204: { description: "Deleted" }, 401: err("Not signed in"), 404: err("No such project or board") },
});

type Row = { id: string; title: string; blocks: string; created_at: string; updated_at: string };
const toBoard = (r: Row): z.infer<typeof Board> => ({ id: r.id, title: r.title, blocks: JSON.parse(r.blocks) as z.infer<typeof Block>[], createdAt: r.created_at, updatedAt: r.updated_at });
const unique = (blocks: { id: string }[]) => {
  if (new Set(blocks.map((b) => b.id)).size !== blocks.length) throw AppError.badRequest("block ids must be unique");
};

export function registerBoards(app: OpenAPIHono<AppEnv>) {
  app.openapi(listRoute, async (c) => {
    const user = await requireUser(c);
    const { projectId } = c.req.valid("param");
    await requireProjectOwner(c.env.DB, user.id, projectId);
    const { results } = await c.env.DB.prepare("SELECT id, title, json_array_length(blocks) AS n, updated_at FROM boards WHERE project_id = ?1 ORDER BY updated_at DESC")
      .bind(projectId)
      .all<{ id: string; title: string; n: number; updated_at: string }>();
    return c.json(results.map((r) => ({ id: r.id, title: r.title, blocks: r.n, updatedAt: r.updated_at })), 200);
  });

  app.openapi(createBoardRoute, async (c) => {
    const user = await requireUser(c);
    const { projectId } = c.req.valid("param");
    const { title, blocks } = c.req.valid("json");
    await requireProjectOwner(c.env.DB, user.id, projectId);
    unique(blocks);
    const row = await c.env.DB.prepare("INSERT INTO boards (id, project_id, title, blocks) VALUES (?1, ?2, ?3, ?4) RETURNING id, title, blocks, created_at, updated_at")
      .bind(crypto.randomUUID(), projectId, title, JSON.stringify(blocks))
      .first<Row>();
    if (!row) throw new AppError("internal", "boards insert returned no row");
    return c.json(toBoard(row), 201);
  });

  app.openapi(getRoute, async (c) => {
    const user = await requireUser(c);
    const { projectId, boardId } = c.req.valid("param");
    await requireProjectOwner(c.env.DB, user.id, projectId);
    const row = await c.env.DB.prepare("SELECT id, title, blocks, created_at, updated_at FROM boards WHERE id = ?1 AND project_id = ?2").bind(boardId, projectId).first<Row>();
    if (!row) throw AppError.notFound(`board ${boardId}`);
    return c.json(toBoard(row), 200);
  });

  app.openapi(putRoute, async (c) => {
    const user = await requireUser(c);
    const { projectId, boardId } = c.req.valid("param");
    const { title, blocks } = c.req.valid("json");
    await requireProjectOwner(c.env.DB, user.id, projectId);
    unique(blocks);
    const row = await c.env.DB.prepare(
      `UPDATE boards SET title = ?3, blocks = ?4, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?1 AND project_id = ?2 RETURNING id, title, blocks, created_at, updated_at`,
    )
      .bind(boardId, projectId, title, JSON.stringify(blocks))
      .first<Row>();
    if (!row) throw AppError.notFound(`board ${boardId}`);
    return c.json(toBoard(row), 200);
  });

  app.openapi(deleteRoute, async (c) => {
    const user = await requireUser(c);
    const { projectId, boardId } = c.req.valid("param");
    await requireProjectOwner(c.env.DB, user.id, projectId);
    const res = await c.env.DB.prepare("DELETE FROM boards WHERE id = ?1 AND project_id = ?2").bind(boardId, projectId).run();
    if (!res.meta.changes) throw AppError.notFound(`board ${boardId}`);
    return c.body(null, 204);
  });
}
