import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { requireUser } from "../auth";
import { applyOps, type BoardBlock, type BoardContent } from "../board-ops";
import { ACTION_KINDS, type Action, answer, type ApiGet, type Turn } from "../coordinator";
import { AppError, ErrorBody } from "../error";
import { requireProjectOwner } from "./projects";

const ProjectParam = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).openapi({ param: { name: "projectId", in: "path" } });
const MessageParam = z.string().regex(/^[A-Za-z0-9-]{1,64}$/).openapi({ param: { name: "messageId", in: "path" } });
const IndexParam = z.coerce.number().int().min(0).max(9).openapi({ param: { name: "index", in: "path" } });

const ActionSchema = z
  .object({
    kind: z.enum(ACTION_KINDS),
    label: z.string(),
    pullId: z.string().optional(),
    path: z.string().optional().openapi({ description: "For `open`: the app route to go to, such as /pr/<id>." }),
    boardId: z.string().optional().openapi({ description: "For `draft_requirements`: the whiteboard to draft from." }),
  })
  .openapi("CoordinatorAction", { description: "Something the coordinator proposes. Nothing runs until the user clicks it." });

const Message = z
  .object({
    id: z.string(),
    role: z.enum(["user", "coordinator"]),
    text: z.string(),
    tools: z.array(z.string()).openapi({ description: "Read tools called for this reply, such as `pulls.list(filter=needs)`." }),
    actions: z.array(ActionSchema),
    ran: z.array(z.number().int()).openapi({ description: "Indexes of `actions` the user already ran." }),
    board: z
      .object({
        boardId: z.string(),
        changes: z.array(z.string()).openapi({ description: "What the coordinator changed on the board, in words, such as `Added a flowchart`." }),
        undone: z.boolean(),
      })
      .nullable()
      .openapi({ description: "The coordinator's changes to the whiteboard the user was on, already applied; null when it changed nothing." }),
    createdAt: z.string(),
  })
  .openapi("CoordinatorMessage");

const BoardOut = z
  .object({
    id: z.string(),
    title: z.string(),
    blocks: z.array(z.object({ id: z.string(), kind: z.enum(["note", "mermaid"]), text: z.string() })),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("CoordinatorBoard", { description: "The whiteboard after the coordinator's change (or its undo)." });

const Screen = z
  .object({
    route: z.string().max(40),
    pullId: z.string().max(64).optional(),
    specId: z.string().max(64).optional(),
    boardId: z.string().max(64).optional(),
  })
  .openapi("CoordinatorScreen", { description: "What the user is looking at." });

const errors = {
  400: { description: "Invalid request", content: { "application/json": { schema: ErrorBody } } },
  401: { description: "Not signed in", content: { "application/json": { schema: ErrorBody } } },
  404: { description: "Not found", content: { "application/json": { schema: ErrorBody } } },
};
const json = <T extends z.ZodTypeAny>(schema: T) => ({ "application/json": { schema } });

const listRoute = createRoute({
  method: "get",
  path: "/api/projects/{projectId}/coordinator",
  summary: "Your conversation with the project's coordinator, oldest first (last 100 messages)",
  request: { params: z.object({ projectId: ProjectParam }) },
  responses: { 200: { description: "Messages", content: json(z.object({ messages: z.array(Message) })) }, 401: errors[401], 404: errors[404] },
});

const sendRoute = createRoute({
  method: "post",
  path: "/api/projects/{projectId}/coordinator",
  summary: "Ask the coordinator",
  description:
    "The coordinator reads what it needs through this API as you (pull requests, gates, specs, jobs) and answers, with up to two proposed actions. " +
    "It runs on Claude Code with the owner's subscription for CLAUDE_CODE_OWNER, else with your own API key, else with the server's.",
  request: { params: z.object({ projectId: ProjectParam }), body: { required: true, content: json(z.object({ text: z.string().trim().min(1).max(2000), screen: Screen })) } },
  responses: {
    200: {
      description: "Your message and the coordinator's reply; `board` is the whiteboard after the coordinator changed it, when it did",
      content: json(z.object({ messages: z.array(Message), board: BoardOut.nullable() })),
    },
    400: errors[400],
    401: errors[401],
    404: errors[404],
    502: { description: "Claude refused or could not be reached", content: json(ErrorBody) },
    503: { description: "Neither Claude Code nor an Anthropic key is configured", content: json(ErrorBody) },
  },
});

const runRoute = createRoute({
  method: "post",
  path: "/api/projects/{projectId}/coordinator/{messageId}/actions/{index}",
  summary: "Run an action the coordinator proposed (your click)",
  description:
    "Runs the action through the same API as the buttons on each page: start the Reviewer agent (`review_pull`), approve, merge, pull from GitHub, re-index. " +
    "`open` is navigation and runs in the browser. The outcome is added to the conversation.",
  request: { params: z.object({ projectId: ProjectParam, messageId: MessageParam, index: IndexParam }) },
  responses: {
    200: { description: "The outcome, and the coordinator's note about it", content: json(z.object({ ok: z.boolean(), messages: z.array(Message) })) },
    400: errors[400],
    401: errors[401],
    404: errors[404],
    409: { description: "Already ran", content: json(ErrorBody) },
  },
});

const undoRoute = createRoute({
  method: "post",
  path: "/api/projects/{projectId}/coordinator/{messageId}/undo",
  summary: "Undo the coordinator's change to the whiteboard",
  description: "Puts the board back as it was before this reply changed it. Only while nobody changed the board since; otherwise 409.",
  request: { params: z.object({ projectId: ProjectParam, messageId: MessageParam }) },
  responses: {
    200: { description: "The message, now undone, and the board as it was", content: json(z.object({ messages: z.array(Message), board: BoardOut })) },
    401: errors[401],
    404: errors[404],
    409: { description: "Already undone, or the board changed since", content: json(ErrorBody) },
  },
});

const clearRoute = createRoute({
  method: "delete",
  path: "/api/projects/{projectId}/coordinator",
  summary: "Start a new conversation with the coordinator",
  request: { params: z.object({ projectId: ProjectParam }) },
  responses: { 200: { description: "Cleared", content: json(z.object({ messages: z.array(Message) })) }, 401: errors[401], 404: errors[404] },
});

interface Row {
  id: string;
  role: "user" | "coordinator";
  text: string;
  tools: string;
  actions: string;
  ran: string;
  board: string | null;
  created_at: string;
}

interface BoardEdit {
  boardId: string;
  changes: string[];
  before: BoardContent;
  at: string;
  undone: boolean;
}
type BoardRow = { id: string; title: string; blocks: string; created_at: string; updated_at: string };
const toBoard = (r: BoardRow) => ({ id: r.id, title: r.title, blocks: parse<BoardBlock[]>(r.blocks, []), createdAt: r.created_at, updatedAt: r.updated_at });
const COLS = "id, role, text, tools, actions, ran, board, created_at";

const parse = <T>(s: string, fallback: T): T => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

const toMessage = (r: Row): z.infer<typeof Message> => ({
  id: r.id,
  role: r.role,
  text: r.text,
  tools: parse<string[]>(r.tools, []),
  actions: parse<Action[]>(r.actions, []),
  ran: parse<number[]>(r.ran, []),
  board: r.board ? (({ boardId, changes, undone }: BoardEdit) => ({ boardId, changes, undone }))(parse<BoardEdit>(r.board, { boardId: "", changes: [], before: { title: "", blocks: [] }, at: "", undone: true })) : null,
  createdAt: r.created_at,
});

type Ctx = Context<AppEnv>;

async function insert(
  c: Ctx,
  projectId: string,
  userId: string,
  m: { role: Row["role"]; text: string; screen?: unknown; tools?: string[]; actions?: Action[]; backend?: string; board?: BoardEdit },
): Promise<Row> {
  const row = await c.env.DB.prepare(
    `INSERT INTO coordinator_messages (id, project_id, user_id, role, text, screen, tools, actions, backend, board) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     RETURNING ${COLS}`,
  )
    .bind(
      crypto.randomUUID(),
      projectId,
      userId,
      m.role,
      m.text,
      m.screen ? JSON.stringify(m.screen) : null,
      JSON.stringify(m.tools ?? []),
      JSON.stringify(m.actions ?? []),
      m.backend ?? null,
      m.board ? JSON.stringify(m.board) : null,
    )
    .first<Row>();
  if (!row) throw new AppError("internal", "coordinator message was not stored");
  return row;
}

type App = OpenAPIHono<AppEnv>;

/** Calls this app's own API as the signed-in user (same cookie), without leaving the Worker. */
function selfCall(app: App, c: Ctx) {
  const cookie = c.req.header("cookie") ?? "";
  const origin = new URL(c.req.url).origin;
  let ctx: Ctx["executionCtx"] | undefined;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = undefined;
  }
  return async (method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> => {
    const headers: Record<string, string> = { cookie };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await app.fetch(new Request(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), c.env, ctx);
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

const errorText = (b: unknown) => ((b as { error?: { message?: string } } | null)?.error?.message ?? "").replace(/^[a-z ]+: /, "");

export function registerCoordinator(app: App) {
  app.openapi(listRoute, async (c) => {
    const user = await requireUser(c);
    const { projectId } = c.req.valid("param");
    await requireProjectOwner(c.env.DB, user.id, projectId);
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM (SELECT ${COLS}, rowid AS n FROM coordinator_messages WHERE project_id = ?1 AND user_id = ?2 ORDER BY created_at DESC, rowid DESC LIMIT 100)
       ORDER BY created_at, n`,
    )
      .bind(projectId, user.id)
      .all<Row>();
    return c.json({ messages: results.map(toMessage) }, 200);
  });

  app.openapi(sendRoute, async (c) => {
    const user = await requireUser(c);
    const { projectId } = c.req.valid("param");
    const { text, screen } = c.req.valid("json");
    await requireProjectOwner(c.env.DB, user.id, projectId);
    const project = await c.env.DB.prepare("SELECT name FROM projects WHERE id = ?1").bind(projectId).first<{ name: string }>();
    const { results } = await c.env.DB.prepare(
      "SELECT role, text FROM coordinator_messages WHERE project_id = ?1 AND user_id = ?2 ORDER BY created_at DESC, rowid DESC LIMIT 12",
    )
      .bind(projectId, user.id)
      .all<Turn>();
    const history = results.reverse();
    const mine = await insert(c, projectId, user.id, { role: "user", text, screen });
    const call = selfCall(app, c);
    const get: ApiGet = (path) => call("GET", path);
    const readBoard = (id: string) => c.env.DB.prepare("SELECT id, title, blocks, created_at, updated_at FROM boards WHERE id = ?1 AND project_id = ?2").bind(id, projectId).first<BoardRow>();
    const seen = screen.boardId ? await readBoard(screen.boardId) : null;
    const board = seen ? { id: seen.id, title: seen.title, blocks: parse<BoardBlock[]>(seen.blocks, []) } : undefined;
    const out = await answer(c.env, user, { projectId, projectName: project?.name ?? "", history, question: text, screen, board, get });

    // The coordinator's pen: applied to the board as it is now (the user may
    // have kept drawing while it thought), with the board before kept for undo.
    let edit: BoardEdit | undefined;
    let after: BoardRow | null = null;
    const now = board && out.board.length ? await readBoard(board.id) : null;
    if (now) {
      const before = { title: now.title, blocks: parse<BoardBlock[]>(now.blocks, []) };
      const next = applyOps(before, out.board);
      if (next.changes.length) {
        after = await c.env.DB.prepare(
          `UPDATE boards SET title = ?3, blocks = ?4, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = ?1 AND project_id = ?2 RETURNING id, title, blocks, created_at, updated_at`,
        )
          .bind(now.id, projectId, next.title, JSON.stringify(next.blocks))
          .first<BoardRow>();
        if (after) edit = { boardId: after.id, changes: next.changes, before, at: after.updated_at, undone: false };
      }
    }
    const reply = await insert(c, projectId, user.id, { role: "coordinator", text: out.text, tools: out.tools, actions: out.actions, backend: out.backend, board: edit });
    return c.json({ messages: [toMessage(mine), toMessage(reply)], board: after ? toBoard(after) : null }, 200);
  });

  app.openapi(runRoute, async (c) => {
    const user = await requireUser(c);
    const { projectId, messageId, index } = c.req.valid("param");
    await requireProjectOwner(c.env.DB, user.id, projectId);
    const row = await c.env.DB.prepare(`SELECT ${COLS} FROM coordinator_messages WHERE id = ?1 AND project_id = ?2 AND user_id = ?3`)
      .bind(messageId, projectId, user.id)
      .first<Row>();
    if (!row) throw AppError.notFound(`message ${messageId}`);
    const msg = toMessage(row);
    const action = msg.actions[index];
    if (!action) throw AppError.notFound(`action ${index}`);
    if (action.kind === "open") throw AppError.badRequest("`open` runs in the browser");
    if (msg.ran.includes(index)) throw new AppError("conflict", "conflict: this action already ran");

    const call = selfCall(app, c);
    const p = encodeURIComponent(projectId);
    const pull = encodeURIComponent(action.pullId ?? "");
    const req = {
      review_pull: () => call("POST", `/api/projects/${p}/pulls/${pull}/agent-review`),
      approve_pull: () => call("POST", `/api/projects/${p}/pulls/${pull}/reviews`, { verdict: "approve" }),
      merge_pull: () => call("POST", `/api/projects/${p}/pulls/${pull}/merge`, {}),
      sync_pulls: () => call("POST", `/api/projects/${p}/pulls/sync`, {}),
      reindex: () => call("POST", `/api/projects/${p}/reindex`),
      draft_requirements: () => call("POST", `/api/projects/${p}/requirements`, { boardId: action.boardId }),
    }[action.kind];
    const res = await req();
    const ok = res.status < 300;
    const done = {
      review_pull: "I started the Reviewer agent on this pull request. Its findings and walkthrough show on the PR page when it finishes.",
      approve_pull: "Approved.",
      merge_pull: "Merged.",
      sync_pulls: "Pulling the latest from GitHub.",
      reindex: "Indexing the project again.",
      draft_requirements: "",
    }[action.kind];
    const failed =
      action.kind === "review_pull" && res.status === 404 && !errorText(res.body).startsWith("pull request")
        ? "The Reviewer agent is not available on this server yet."
        : `That did not work${errorText(res.body) ? `: ${errorText(res.body)}` : ` (HTTP ${res.status})`}.`;
    if (ok) {
      await c.env.DB.prepare("UPDATE coordinator_messages SET ran = ?1 WHERE id = ?2").bind(JSON.stringify([...msg.ran, index]), messageId).run();
      msg.ran = [...msg.ran, index];
    }
    const drafted = ok && action.kind === "draft_requirements" ? (res.body as { id: string; title: string; flows: unknown[]; ids: string[] }) : null;
    const note = drafted
      ? await insert(c, projectId, user.id, {
          role: "coordinator",
          text: `I drafted ${drafted.title}: ${drafted.flows.length} ${drafted.flows.length === 1 ? "flow" : "flows"} and ${drafted.ids.filter((i) => i.includes("/")).length} requirements, each with its own id.`,
          actions: [{ kind: "open", label: "Open the requirements", path: `/req/${drafted.id}` }],
        })
      : await insert(c, projectId, user.id, { role: "coordinator", text: ok ? done : failed });
    return c.json({ ok, messages: [msg, toMessage(note)] }, 200);
  });

  app.openapi(undoRoute, async (c) => {
    const user = await requireUser(c);
    const { projectId, messageId } = c.req.valid("param");
    await requireProjectOwner(c.env.DB, user.id, projectId);
    const row = await c.env.DB.prepare(`SELECT ${COLS} FROM coordinator_messages WHERE id = ?1 AND project_id = ?2 AND user_id = ?3`).bind(messageId, projectId, user.id).first<Row>();
    const edit = row?.board ? parse<BoardEdit | null>(row.board, null) : null;
    if (!row || !edit) throw AppError.notFound(`board change on message ${messageId}`);
    if (edit.undone) throw new AppError("conflict", "conflict: already undone");
    const restored = await c.env.DB.prepare(
      `UPDATE boards SET title = ?3, blocks = ?4, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?1 AND project_id = ?2 AND updated_at = ?5 RETURNING id, title, blocks, created_at, updated_at`,
    )
      .bind(edit.boardId, projectId, edit.before.title, JSON.stringify(edit.before.blocks), edit.at)
      .first<BoardRow>();
    if (!restored) {
      const exists = await c.env.DB.prepare("SELECT 1 AS x FROM boards WHERE id = ?1 AND project_id = ?2").bind(edit.boardId, projectId).first();
      if (!exists) throw AppError.notFound(`board ${edit.boardId}`);
      throw new AppError("conflict", "conflict: the board changed after this; undo those changes on the board");
    }
    const undone = { ...edit, undone: true };
    await c.env.DB.prepare("UPDATE coordinator_messages SET board = ?1 WHERE id = ?2").bind(JSON.stringify(undone), messageId).run();
    return c.json({ messages: [toMessage({ ...row, board: JSON.stringify(undone) })], board: toBoard(restored) }, 200);
  });

  app.openapi(clearRoute, async (c) => {
    const user = await requireUser(c);
    const { projectId } = c.req.valid("param");
    await requireProjectOwner(c.env.DB, user.id, projectId);
    await c.env.DB.prepare("DELETE FROM coordinator_messages WHERE project_id = ?1 AND user_id = ?2").bind(projectId, user.id).run();
    return c.json({ messages: [] }, 200);
  });
}
