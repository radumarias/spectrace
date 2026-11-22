import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "../src/auth";
import { MODELS } from "../src/ai";
import { applyOps, cleanOps } from "../src/board-ops";
import { parseAnswer, systemPrompt } from "../src/coordinator";

// Claude is never called: Anthropic (http://anthropic.test) and the Claude Code
// container (http://claude-code.test) are a scripted fake model that picks a
// tool from the question, then answers once it has the tool's result.
const prompts: { origin: string; prompt: string; system: string }[] = [];

function pickTool(question: string, screen: string): string {
  const q = question.toLowerCase();
  const pull = /pull id=([\w-]+)/.exec(screen)?.[1];
  if (/need|today|inbox/.test(q)) return JSON.stringify({ tools: [{ name: "pulls.list", args: { filter: "needs" } }] });
  if (/merge/.test(q)) return JSON.stringify({ tools: [{ name: "pull.get", args: { pull: pull ?? "" } }] });
  if (/summar/.test(q)) return "```json\n" + JSON.stringify({ tools: [{ name: "pull.get", args: { pull: "#7" } }] }) + "\n```";
  if (/agent|doing/.test(q)) return JSON.stringify({ tools: [{ name: "jobs.list", args: {} }] });
  if (/spec|untested/.test(q)) return JSON.stringify({ tools: [{ name: "specs.list", args: {} }] });
  if (/project|repos/.test(q)) return JSON.stringify({ tools: [{ name: "project.get", args: {} }] });
  return JSON.stringify({ reply: "Ask me about pull requests, gates, specs or agents." });
}

let replyWith: (prompt: string) => string;
function defaultReply(prompt: string): string {
  if (!prompt.includes("Tool results:")) {
    const question = [...prompt.matchAll(/^User: (.*)$/gm)].pop()?.[1] ?? "";
    return pickTool(question, /^The user is on: (.*)$/m.exec(prompt)?.[1] ?? "");
  }
  const id = /"id":"(pr-[\w-]+)"/.exec(prompt)?.[1];
  return JSON.stringify({ reply: "Done looking.", actions: id ? [{ kind: "review_pull", label: "Start agent review", pullId: id }, { kind: "open", label: "Open PR", path: `/pr/${id}` }] : [] });
}

function fakeModel() {
  const real = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    if (url.origin === "http://anthropic.test") {
      const body = (await req.json()) as { system?: string; messages: { content: string }[] };
      const prompt = body.messages[0]!.content;
      prompts.push({ origin: url.origin, prompt, system: body.system ?? "" });
      return Response.json({ id: "m", model: MODELS.sonnet, stop_reason: "end_turn", content: [{ type: "text", text: replyWith(prompt) }], usage: { input_tokens: 1, output_tokens: 1 } });
    }
    if (url.origin === "http://claude-code.test") {
      const body = (await req.json()) as { prompt: string; system?: string };
      prompts.push({ origin: url.origin, prompt: body.prompt, system: body.system ?? "" });
      return Response.json({ result: replyWith(body.prompt), isError: false, model: MODELS.sonnet, numTurns: 1, durationMs: 5, costUsd: 0 });
    }
    return real(input, init);
  });
}

let n = 0;
async function seed() {
  const login = `coord-${++n}-${crypto.randomUUID().slice(0, 8)}`;
  const userId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO users (id, github_id, login) VALUES (?1, ?2, ?3)").bind(userId, 8_000_000 + n, login).run();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(crypto.randomUUID(), userId, await hashToken(login), new Date(Date.now() + 86_400_000).toISOString())
    .run();
  const projectId = `proj-${userId}`;
  await env.DB.prepare("INSERT INTO projects (id, owner_id, name, context) VALUES (?1, ?2, 'Shop', 'An online shop')").bind(projectId, userId).run();
  const repoId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO project_repos (id, project_id, full_name) VALUES (?1, ?2, 'acme/shop')").bind(repoId, projectId).run();
  const pullId = `pr-${repoId}`;
  await env.DB.prepare(
    `INSERT INTO pull_requests (id, repo_id, number, github_pr_id, title, author_login, state, draft, head_ref, head_sha, base_ref, html_url, github_created_at, github_updated_at)
     VALUES (?1, ?2, 7, ?3, 'Add refunds to checkout', 'mona', 'open', 0, 'feat', 'sha1', 'main', 'https://github.com/acme/shop/pull/7', '2026-11-01T00:00:00Z', '2026-11-10T00:00:00Z')`,
  )
    .bind(pullId, repoId, 30_000 + n)
    .run();
  await env.DB.prepare("INSERT INTO jobs (id, project_id, kind, target, state) VALUES (?1, ?2, 'index', 'acme/shop', 'running')").bind(crypto.randomUUID(), projectId).run();
  return { login, cookie: `spectrace_session=${login}`, projectId, pullId, base: `/api/projects/${projectId}/coordinator` };
}
type Seed = Awaited<ReturnType<typeof seed>>;

const call = (path: string, cookie: string | null, init: RequestInit & { json?: unknown } = {}) => {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    init = { ...init, body: JSON.stringify(init.json) };
  }
  return exports.default.fetch(new Request(`http://spectrace.test${path}`, { ...init, headers }));
};

type Msg = { id: string; role: string; text: string; tools: string[]; actions: { kind: string; pullId?: string; path?: string }[]; ran: number[] };
const askIt = async (s: Seed, text: string, screen: Record<string, string> = { route: "home" }) => {
  const res = await call(s.base, s.cookie, { method: "POST", json: { text, screen } });
  return { status: res.status, body: (await res.json()) as { messages: Msg[] } };
};

beforeEach(() => {
  prompts.length = 0;
  replyWith = defaultReply;
  env.ANTHROPIC_API_KEY = "sk-ant-test";
  fakeModel();
});
afterEach(() => {
  vi.restoreAllMocks();
  env.ANTHROPIC_API_KEY = undefined;
  env.CLAUDE_CODE_OWNER = undefined;
});

describe("POST /coordinator: the right tool for each question", () => {
  it("'What needs me today?' lists the needs-you inbox", async () => {
    const s = await seed();
    const { status, body } = await askIt(s, "What needs me today?");
    expect(status).toBe(200);
    const [mine, reply] = body.messages;
    expect(mine).toMatchObject({ role: "user", text: "What needs me today?" });
    expect(reply).toMatchObject({ role: "coordinator", text: "Done looking.", tools: ["pulls.list(filter=needs)"] });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.prompt).toContain('"title":"Add refunds to checkout"');
    expect(prompts[1]!.prompt).toContain('"needs":1');
  });

  it("'Can I merge?' on a PR reads that PR with its gates", async () => {
    const s = await seed();
    const { body } = await askIt(s, "Can I merge?", { route: "pr", pullId: s.pullId });
    expect(body.messages[1]!.tools).toEqual([`pull.get(pull=${s.pullId})`]);
    expect(prompts[0]!.prompt).toContain(`The user is on: route=pr, pull id=${s.pullId}`);
    expect(prompts[1]!.prompt).toContain('{"gate":"Your approval","state":"open"}');
    expect(prompts[1]!.prompt).toContain('"gate":"Agent review finished"');
  });

  it("'Summarize #7' finds the PR by its number", async () => {
    const s = await seed();
    const { body } = await askIt(s, "Summarize #7");
    expect(body.messages[1]!.tools).toEqual(["pull.get(pull=#7)"]);
    expect(prompts[1]!.prompt).toContain(`"id":"${s.pullId}"`);
  });

  it("'What are the agents doing?' lists jobs", async () => {
    const s = await seed();
    const { body } = await askIt(s, "What are the agents doing?");
    expect(body.messages[1]!.tools).toEqual(["jobs.list()"]);
    expect(prompts[1]!.prompt).toContain('"kind":"index"');
    expect(prompts[1]!.prompt).toContain('"state":"running"');
  });

  it("'Which specs have untested steps?' lists specs", async () => {
    const s = await seed();
    const { body } = await askIt(s, "Which specs have untested steps?");
    expect(body.messages[1]!.tools).toEqual(["specs.list()"]);
    expect(prompts[1]!.prompt).toContain("specs.list() -> []");
  });

  it("'Which repos are in this project?' reads the project", async () => {
    const s = await seed();
    const { body } = await askIt(s, "Which repos are in this project?");
    expect(body.messages[1]!.tools).toEqual(["project.get()"]);
    expect(prompts[1]!.prompt).toContain('"full_name":"acme/shop"');
    expect(prompts[1]!.prompt).toContain('"context":"An online shop"');
  });

  it("answers without tools when none are needed, and lists tools and agents in the system prompt", async () => {
    const s = await seed();
    const { body } = await askIt(s, "hello");
    expect(body.messages[1]).toMatchObject({ text: "Ask me about pull requests, gates, specs or agents.", tools: [], actions: [] });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.system).toBe(systemPrompt());
    expect(prompts[0]!.system).toContain("- review_pull: start the Reviewer agent");
  });
});

describe("POST /coordinator: backends and history", () => {
  it("runs the owner's chat on Claude Code (the subscription), not the API", async () => {
    const s = await seed();
    env.CLAUDE_CODE_OWNER = s.login;
    await askIt(s, "What needs me today?");
    expect(prompts.map((p) => p.origin)).toEqual(["http://claude-code.test", "http://claude-code.test"]);
  });

  it("sends the earlier conversation with the next question, and GET returns it in order", async () => {
    const s = await seed();
    await askIt(s, "hello");
    prompts.length = 0;
    await askIt(s, "What are the agents doing?");
    expect(prompts[0]!.prompt).toContain("Conversation so far:\nUser: hello\nCoordinator: Ask me about");
    const list = (await (await call(s.base, s.cookie)).json()) as { messages: Msg[] };
    expect(list.messages.map((m) => m.role)).toEqual(["user", "coordinator", "user", "coordinator"]);
    expect((await call(s.base, s.cookie, { method: "DELETE" })).status).toBe(200);
    expect(((await (await call(s.base, s.cookie)).json()) as { messages: Msg[] }).messages).toEqual([]);
  });

  it("stops after four rounds when the model keeps asking for tools", async () => {
    const s = await seed();
    replyWith = () => JSON.stringify({ tools: [{ name: "jobs.list", args: {} }] });
    const { body } = await askIt(s, "loop");
    expect(prompts).toHaveLength(4);
    expect(prompts[3]!.prompt).toContain("Answer now with the reply shape; no more tools.");
    expect(body.messages[1]!.text).toContain("could not finish");
  });

  it("is only for the project's owner and signed-in users", async () => {
    const s = await seed();
    const other = await seed();
    expect((await call(s.base, other.cookie, { method: "POST", json: { text: "hi", screen: { route: "home" } } })).status).toBe(404);
    expect((await call(s.base, null)).status).toBe(401);
    expect((await call(s.base, s.cookie, { method: "POST", json: { text: "  ", screen: { route: "home" } } })).status).toBe(400);
  });

  it("answers 503 when no Claude is configured", async () => {
    const s = await seed();
    env.ANTHROPIC_API_KEY = undefined;
    expect((await askIt(s, "hello")).status).toBe(503);
  });
});

describe("POST /coordinator/{message}/actions/{index}", () => {
  it("delegates review to the Reviewer agent only on a click, and says so when it is not on the server", async () => {
    const s = await seed();
    const { body } = await askIt(s, "What needs me today?");
    const reply = body.messages[1]!;
    expect(reply.actions).toEqual([
      { kind: "review_pull", label: "Start agent review", pullId: s.pullId },
      { kind: "open", label: "Open PR", path: `/pr/${s.pullId}` },
    ]);
    const res = await call(`${s.base}/${reply.id}/actions/0`, s.cookie, { method: "POST" });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { ok: boolean; messages: Msg[] };
    // The agent-review route arrives with the Reviewer agent; until then the click explains it.
    if (out.ok) {
      expect(out.messages[0]!.ran).toEqual([0]);
      expect(out.messages[1]!.text).toContain("started the Reviewer agent");
    } else {
      expect(out.messages[1]!.text).toBe("The Reviewer agent is not available on this server yet.");
    }
    expect((await call(`${s.base}/${reply.id}/actions/1`, s.cookie, { method: "POST" })).status).toBe(400);
    expect((await call(`${s.base}/${reply.id}/actions/5`, s.cookie, { method: "POST" })).status).toBe(404);
  });

  it("runs a sync once, through the same API as the page's button", async () => {
    const s = await seed();
    replyWith = () => JSON.stringify({ reply: "Pull first.", actions: [{ kind: "sync_pulls", label: "Pull from GitHub" }] });
    const reply = (await askIt(s, "refresh")).body.messages[1]!;
    const out = (await (await call(`${s.base}/${reply.id}/actions/0`, s.cookie, { method: "POST" })).json()) as { ok: boolean; messages: Msg[] };
    expect(out.ok).toBe(true);
    expect(out.messages[0]!.ran).toEqual([0]);
    expect(out.messages[1]!.text).toBe("Pulling the latest from GitHub.");
    const job = await env.DB.prepare("SELECT kind FROM jobs WHERE project_id = ?1 AND kind = 'sync'").bind(s.projectId).first<{ kind: string }>();
    expect(job?.kind).toBe("sync");
    expect((await call(`${s.base}/${reply.id}/actions/0`, s.cookie, { method: "POST" })).status).toBe(409);
  });
});

describe("parseAnswer", () => {
  it("reads tools, replies, fenced JSON and plain text, and drops what it cannot trust", () => {
    expect(parseAnswer('{"tools":[{"name":"pulls.list","args":{"filter":"needs"}},{"name":"rm.rf","args":{}}]}')).toEqual({
      kind: "tools",
      calls: [{ name: "pulls.list", args: { filter: "needs" } }],
    });
    expect(parseAnswer('Sure:\n```json\n{"reply":"Yes {really}.","actions":[{"kind":"merge_pull","pullId":"p-1"},{"kind":"open","path":"https://evil"},{"kind":"drop_db"}]}\n```')).toEqual({
      kind: "reply",
      text: "Yes {really}.",
      actions: [{ kind: "merge_pull", label: "Merge", pullId: "p-1" }],
    });
    expect(parseAnswer("Just text.")).toEqual({ kind: "reply", text: "Just text.", actions: [] });
    expect(parseAnswer('{"tools":[{"name":"nope"}]}')).toEqual({ kind: "reply", text: '{"tools":[{"name":"nope"}]}', actions: [] });
  });
});

describe("POST /coordinator on a whiteboard: the coordinator draws while it talks", () => {
  const FLOW = "flowchart LR\n  cart[Cart]\n  pay[Pay]\n  cart -->|checkout| pay";
  async function withBoard(s: Seed) {
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO boards (id, project_id, title, blocks) VALUES (?1, ?2, 'Checkout', ?3)")
      .bind(id, s.projectId, JSON.stringify([{ id: "b1", kind: "mermaid", text: "flowchart LR" }]))
      .run();
    return id;
  }
  const getBoard = async (s: Seed, id: string) =>
    (await (await call(`/api/projects/${s.projectId}/boards/${id}`, s.cookie)).json()) as { title: string; blocks: { id: string; kind: string; text: string }[]; updatedAt: string };
  type Out = { messages: (Msg & { board: { boardId: string; changes: string[]; undone: boolean } | null })[]; board: { blocks: { id: string; text: string }[] } | null };

  it("sees the board, draws on it in the same reply, and one click undoes it", async () => {
    const s = await seed();
    const boardId = await withBoard(s);
    replyWith = () =>
      JSON.stringify({
        reply: "Here is the flow as I understand it. What happens when the card is declined?",
        board: [
          { op: "set", id: "b1", text: FLOW },
          { op: "add", kind: "note", text: "- Pay: WHEN the card is declined THE SYSTEM SHALL show why." },
          { op: "title", text: "Checkout flow" },
          { op: "drop", id: "b1" },
        ],
      });
    const res = await call(s.base, s.cookie, { method: "POST", json: { text: "Let's sketch checkout", screen: { route: "board", boardId } } });
    expect(res.status).toBe(200);
    const out = (await res.json()) as Out;
    expect(prompts[0]!.system).toBe(systemPrompt(true));
    expect(prompts[0]!.system).toContain('{"op":"add","kind":"mermaid"|"note"');
    expect(prompts[0]!.prompt).toContain('The whiteboard "Checkout" (board id=' + boardId + "), 1 blocks in order:\n[b1] mermaid:\nflowchart LR");
    const reply = out.messages[1]!;
    expect(reply.board).toEqual({ boardId, changes: ["Changed a flowchart (block 1)", "Added a note", "Renamed the board to Checkout flow"], undone: false });
    expect(out.board!.blocks.map((b) => b.text)).toEqual([FLOW, "- Pay: WHEN the card is declined THE SYSTEM SHALL show why."]);
    const saved = await getBoard(s, boardId);
    expect(saved.title).toBe("Checkout flow");
    expect(saved.blocks).toHaveLength(2);

    const listed = (await (await call(s.base, s.cookie)).json()) as Out;
    expect(listed.messages[1]!.board?.changes).toHaveLength(3);

    const undo = await call(`${s.base}/${reply.id}/undo`, s.cookie, { method: "POST" });
    expect(undo.status).toBe(200);
    const u = (await undo.json()) as Out;
    expect(u.messages[0]!.board?.undone).toBe(true);
    expect(u.board!.blocks).toEqual([{ id: "b1", kind: "mermaid", text: "flowchart LR" }]);
    expect((await getBoard(s, boardId)).title).toBe("Checkout");
    expect((await call(`${s.base}/${reply.id}/undo`, s.cookie, { method: "POST" })).status).toBe(409);
  });

  it("does not undo over changes the user made after it", async () => {
    const s = await seed();
    const boardId = await withBoard(s);
    replyWith = () => JSON.stringify({ reply: "Added.", board: [{ op: "add", kind: "mermaid", text: "sequenceDiagram\n  A->>B: hi" }] });
    const out = (await (await call(s.base, s.cookie, { method: "POST", json: { text: "draw", screen: { route: "board", boardId } } })).json()) as Out;
    expect(out.messages[1]!.board?.changes).toEqual(["Added a sequence diagram"]);
    const put = await call(`/api/projects/${s.projectId}/boards/${boardId}`, s.cookie, { method: "PUT", json: { title: "Mine", blocks: [] } });
    expect(put.status).toBe(200);
    expect((await call(`${s.base}/${out.messages[1]!.id}/undo`, s.cookie, { method: "POST" })).status).toBe(409);
    expect((await getBoard(s, boardId)).title).toBe("Mine");
  });

  it("changes nothing off a board, or on another project's board", async () => {
    const s = await seed();
    const other = await seed();
    const theirs = await withBoard(other);
    replyWith = () => JSON.stringify({ reply: "Sure.", board: [{ op: "add", kind: "note", text: "x" }] });
    const off = (await (await call(s.base, s.cookie, { method: "POST", json: { text: "hi", screen: { route: "home" } } })).json()) as Out;
    expect(off.messages[1]!.board).toBeNull();
    expect(off.board).toBeNull();
    expect(prompts[0]!.system).toBe(systemPrompt());
    const cross = (await (await call(s.base, s.cookie, { method: "POST", json: { text: "hi", screen: { route: "board", boardId: theirs } } })).json()) as Out;
    expect(cross.board).toBeNull();
    expect((await getBoard(other, theirs)).blocks).toHaveLength(1);
    expect((await call(`${s.base}/${off.messages[1]!.id}/undo`, s.cookie, { method: "POST" })).status).toBe(404);
  });
});

describe("board ops", () => {
  it("keeps only well-formed ops, at most eight", () => {
    expect(cleanOps([{ op: "add", kind: "svg", text: "x" }, { op: "set", id: "bad id!", text: "x" }, { op: "remove", id: "b1" }, { op: "title", text: "  " }, null])).toEqual([{ op: "remove", id: "b1" }]);
    expect(cleanOps(Array.from({ length: 12 }, () => ({ op: "remove", id: "b1" })))).toHaveLength(8);
    expect(cleanOps("nope")).toEqual([]);
  });

  it("adds after a block, skips ops on missing blocks and says what changed", () => {
    let n = 0;
    const out = applyOps(
      { title: "T", blocks: [{ id: "a", kind: "note", text: "1" }, { id: "b", kind: "note", text: "2" }] },
      [{ op: "add", kind: "mermaid", text: "erDiagram", after: "a" }, { op: "remove", id: "zz" }, { op: "set", id: "b", text: "2" }, { op: "remove", id: "b" }],
      () => `n${++n}`,
    );
    expect(out.blocks.map((b) => b.id)).toEqual(["a", "n1"]);
    expect(out.changes).toEqual(["Added an ER diagram", "Removed a note (block 3)"]);
  });

  it("parseAnswer carries the board ops of a reply", () => {
    expect(parseAnswer('{"reply":"ok","board":[{"op":"title","text":"X"}]}')).toEqual({ kind: "reply", text: "ok", actions: [], board: [{ op: "title", text: "X" }] });
  });
});
