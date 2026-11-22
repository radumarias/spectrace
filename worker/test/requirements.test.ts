import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "../src/auth";
import { MODELS } from "../src/ai";
import { parseDraft, systemPrompt } from "../src/requirements";

// Claude is never called: Anthropic (http://anthropic.test) is a scripted fake
// that answers each prompt from `answers`, in order.
const prompts: { prompt: string; system: string }[] = [];
let answers: string[] = [];

const GOOD = [
  "# Checkout {#checkout}",
  "",
  "```mermaid",
  "flowchart LR",
  "  cart[Cart]",
  "  pay[Pay]",
  "  cart -->|checkout| pay",
  "```",
  "",
  "## Cart {#checkout.cart}",
  "",
  "- WHEN the user opens the cart THE SYSTEM SHALL list every item with its price. {#r1}",
  "",
  "## Pay {#checkout.pay}",
  "",
  "- WHEN the user confirms payment THE SYSTEM SHALL charge the card once. {#r1}",
  "- WHEN a payment is declined THE SYSTEM SHALL show the reason. {#r2}",
  "",
].join("\n");
const BROKEN = GOOD.replace("  cart -->|checkout| pay\n", "  cart --> pay\n");
const draft = (source: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    title: "Checkout",
    flows: [{ flow: "checkout", title: "Checkout", source }],
    views: [
      { of: "checkout.pay", kind: "mockup", title: "Pay screen", text: "### Pay\n\n- Card number\n- [Pay now]\n\nShows: checkout.pay/r1" },
      { of: "checkout.nowhere", kind: "note", title: "Question", text: "Do we keep the cart for 14 days?" },
      { of: null, kind: "diagram", title: "Calls", text: "sequenceDiagram\n  App->>Bank: charge" },
      { of: "checkout.pay", kind: "video", title: "x", text: "x" },
    ],
    ...extra,
  });

function fakeModel() {
  const real = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    if (new URL(req.url).origin === "http://anthropic.test") {
      const body = (await req.json()) as { system?: string; messages: { content: string }[] };
      prompts.push({ prompt: body.messages[0]!.content, system: body.system ?? "" });
      const text = answers.shift() ?? "no";
      return Response.json({ id: "m", model: MODELS.sonnet, stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 } });
    }
    return real(input, init);
  });
}

let n = 0;
async function seed(blocks: unknown[] = [{ id: "b1", kind: "mermaid", text: "flowchart LR\n  cart[Cart]\n  pay[Pay]\n  cart -->|checkout| pay" }]) {
  const login = `req-${++n}-${crypto.randomUUID().slice(0, 8)}`;
  const userId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO users (id, github_id, login) VALUES (?1, ?2, ?3)").bind(userId, 9_000_000 + n, login).run();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(crypto.randomUUID(), userId, await hashToken(login), new Date(Date.now() + 86_400_000).toISOString())
    .run();
  const projectId = `proj-${userId}`;
  await env.DB.prepare("INSERT INTO projects (id, owner_id, name, context) VALUES (?1, ?2, 'Shop', 'An online shop')").bind(projectId, userId).run();
  const boardId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO boards (id, project_id, title, blocks) VALUES (?1, ?2, 'Checkout', ?3)").bind(boardId, projectId, JSON.stringify(blocks)).run();
  await env.DB.prepare("INSERT INTO coordinator_messages (id, project_id, user_id, role, text) VALUES (?1, ?2, ?3, 'user', 'Cards only, no PayPal.')").bind(crypto.randomUUID(), projectId, userId).run();
  return { cookie: `spectrace_session=${login}`, projectId, boardId, base: `/api/projects/${projectId}/requirements` };
}

const call = (path: string, cookie: string | null, init: RequestInit & { json?: unknown } = {}) => {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    init = { ...init, body: JSON.stringify(init.json) };
  }
  return exports.default.fetch(new Request(`http://spectrace.test${path}`, { ...init, headers }));
};

type Set = {
  id: string;
  title: string;
  boardId: string;
  flows: { flow: string; path: string; source: string; model: { sections: { id: string }[] } | null; diagnostics: { code: string }[] }[];
  views: { id: string; of: string | null; kind: string; title: string }[];
  ids: string[];
};

beforeEach(() => {
  prompts.length = 0;
  answers = [];
  env.ANTHROPIC_API_KEY = "sk-ant-test";
  fakeModel();
});
afterEach(() => {
  vi.restoreAllMocks();
  env.ANTHROPIC_API_KEY = undefined;
});

describe("POST /requirements: draft from a board and its discussion", () => {
  it("drafts flows with stable ids and views of them, and lists and reads the set", async () => {
    const s = await seed();
    answers = [draft(GOOD)];
    const res = await call(s.base, s.cookie, { method: "POST", json: { boardId: s.boardId } });
    expect(res.status).toBe(201);
    const set = (await res.json()) as Set;
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.system).toBe(systemPrompt());
    expect(prompts[0]!.prompt).toContain('The whiteboard "Checkout":\n[mermaid]\nflowchart LR\n  cart[Cart]');
    expect(prompts[0]!.prompt).toContain("User: Cards only, no PayPal.");
    expect(prompts[0]!.prompt).toContain("Project context: An online shop");
    expect(set.ids).toEqual(["checkout", "checkout.cart", "checkout.cart/r1", "checkout.pay", "checkout.pay/r1", "checkout.pay/r2"]);
    expect(set.flows[0]).toMatchObject({ flow: "checkout", path: "spec/checkout.md", diagnostics: [] });
    expect(set.flows[0]!.model!.sections.map((x) => x.id)).toEqual(["checkout.cart", "checkout.pay"]);
    // Unknown kinds are dropped; a view of an id that does not exist belongs to the whole set.
    expect(set.views.map((v) => [v.kind, v.of])).toEqual([["mockup", "checkout.pay"], ["note", null], ["diagram", null]]);

    const list = (await (await call(s.base, s.cookie)).json()) as { id: string; flows: number; requirements: number; boardId: string }[];
    expect(list).toEqual([expect.objectContaining({ id: set.id, flows: 1, requirements: 3, boardId: s.boardId })]);
    const one = (await (await call(`${s.base}/${set.id}`, s.cookie)).json()) as Set;
    expect(one.flows[0]!.model).not.toBeNull();
    expect((await call(`${s.base}/${set.id}`, s.cookie, { method: "DELETE" })).status).toBe(204);
    expect((await call(`${s.base}/${set.id}`, s.cookie)).status).toBe(404);
  });

  it("sends a flow the parser rejects back once, with its errors", async () => {
    const s = await seed();
    answers = [draft(BROKEN), draft(GOOD)];
    const set = (await (await call(s.base, s.cookie, { method: "POST", json: { boardId: s.boardId } })).json()) as Set;
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.prompt).toContain("Your last answer had flows the parser rejected.");
    expect(prompts[1]!.prompt).toContain("Flow checkout:\n- line 7: S005");
    expect(set.flows[0]!.diagnostics).toEqual([]);
  });

  it("keeps a flow that still does not parse, with its diagnostics, and issues no ids for it", async () => {
    const s = await seed();
    answers = [draft(BROKEN), draft(BROKEN)];
    const set = (await (await call(s.base, s.cookie, { method: "POST", json: { boardId: s.boardId } })).json()) as Set;
    expect(set.flows[0]!.model).toBeNull();
    expect(set.flows[0]!.diagnostics.map((d) => d.code)).toContain("S005");
    expect(set.ids).toEqual([]);
  });

  it("answers 502 when Claude twice answers without requirements, and 400 on an empty board", async () => {
    const s = await seed();
    answers = ["Sure, here you go!", "{}"];
    expect((await call(s.base, s.cookie, { method: "POST", json: { boardId: s.boardId } })).status).toBe(502);
    const empty = await seed([{ id: "b1", kind: "mermaid", text: "flowchart LR" }]);
    expect((await call(empty.base, empty.cookie, { method: "POST", json: { boardId: empty.boardId } })).status).toBe(400);
  });

  it("is only for the project's owner", async () => {
    const s = await seed();
    const other = await seed();
    expect((await call(s.base, other.cookie, { method: "POST", json: { boardId: s.boardId } })).status).toBe(404);
    expect((await call(s.base, s.cookie, { method: "POST", json: { boardId: other.boardId } })).status).toBe(404);
    expect((await call(s.base, null)).status).toBe(401);
  });
});

describe("the coordinator hands drafting to the Requirements writer on a click", () => {
  it("proposes draft_requirements on a board and the click drafts and links the set", async () => {
    const s = await seed();
    answers = [JSON.stringify({ reply: "I think we have it.", actions: [{ kind: "draft_requirements", label: "Draft requirements", boardId: s.boardId }] }), draft(GOOD)];
    const coord = `/api/projects/${s.projectId}/coordinator`;
    const asked = (await (await call(coord, s.cookie, { method: "POST", json: { text: "done?", screen: { route: "board", boardId: s.boardId } } })).json()) as {
      messages: { id: string; actions: { kind: string; boardId?: string }[] }[];
    };
    const reply = asked.messages[1]!;
    expect(reply.actions).toEqual([{ kind: "draft_requirements", label: "Draft requirements", boardId: s.boardId }]);
    const out = (await (await call(`${coord}/${reply.id}/actions/0`, s.cookie, { method: "POST" })).json()) as { ok: boolean; messages: { text: string; actions: { path?: string }[] }[] };
    expect(out.ok).toBe(true);
    expect(out.messages[1]!.text).toBe("I drafted Checkout: 1 flow and 3 requirements, each with its own id.");
    expect(out.messages[1]!.actions[0]!.path).toMatch(/^\/req\/[\w-]+$/);
  });
});

describe("parseDraft", () => {
  it("keeps valid, unique flow ids and reads fenced JSON", () => {
    const d = parseDraft("```json\n" + JSON.stringify({ title: "T", flows: [{ flow: "Bad-Id", source: "x" }, { flow: "ok", source: "x" }, { flow: "ok", source: "y" }] }) + "\n```");
    expect(d?.flows.map((f) => f.flow)).toEqual(["ok"]);
    expect(parseDraft('{"flows":[]}')).toBeNull();
  });
});

describe("POST /coordinator on a requirements set: revise through the coordinator, ids stay", () => {
  async function withSet(s: Awaited<ReturnType<typeof seed>>) {
    answers = [draft(GOOD)];
    const set = (await (await call(s.base, s.cookie, { method: "POST", json: { boardId: s.boardId } })).json()) as Set;
    prompts.length = 0;
    return set;
  }
  type Out = {
    messages: { id: string; requirements: { setId: string; changes: string[]; skipped: string[]; undone: boolean } | null }[];
    requirementSet: Set | null;
  };
  const ask = async (s: Awaited<ReturnType<typeof seed>>, setId: string, reply: unknown) => {
    answers = [JSON.stringify(reply)];
    const res = await call(`/api/projects/${s.projectId}/coordinator`, s.cookie, { method: "POST", json: { text: "change it", screen: { route: "req", setId } } });
    expect(res.status).toBe(200);
    return (await res.json()) as Out;
  };

  it("edits by id, never reuses a retired tag or step id, and undo keeps the ids issued", async () => {
    const s = await seed();
    const set = await withSet(s);
    const first = await ask(s, set.id, {
      reply: "Split the decline into its own step and dropped r2.",
      requirements: [
        { op: "edit", flow: "checkout", edit: { op: "setRequirement", node: "pay", tag: "r1", condition: "the user confirms payment", response: "charge the card exactly once" } },
        { op: "edit", flow: "checkout", edit: { op: "removeRequirement", node: "pay", tag: "r2" } },
        { op: "edit", flow: "checkout", edit: { op: "addRequirement", node: "pay", condition: "the bank takes over 10 seconds", response: "show a spinner" } },
        { op: "edit", flow: "checkout", edit: { op: "addStep", node: "failed", label: "Declined", from: "pay", edgeLabel: "declined" } },
        { op: "addView", of: "checkout.failed", kind: "mockup", title: "Declined screen", text: "### Declined\n\n- [Try again]" },
        { op: "edit", flow: "nowhere", edit: { op: "removeStep", node: "x" } },
      ],
    });
    expect(prompts[0]!.system).toContain('{"op":"addRequirement","node":"<node>"');
    expect(prompts[0]!.prompt).toContain(`The requirements set "Checkout" (set id=${set.id}).`);
    expect(prompts[0]!.prompt).toContain("--- [v1] mockup \"Pay screen\" of checkout.pay");
    const edit = first.messages[1]!.requirements!;
    expect(edit.changes).toEqual([
      "Changed checkout.pay/r1",
      "Removed checkout.pay/r2 (its id is retired)",
      "Added checkout.pay/r3",
      "Added step checkout.failed",
      "Added the mockup Declined screen",
    ]);
    expect(edit.skipped).toEqual(["no flow nowhere"]);
    const after = first.requirementSet!;
    expect(after.flows[0]!.source).toContain("- WHEN the bank takes over 10 seconds THE SYSTEM SHALL show a spinner. {#r3}");
    expect(after.flows[0]!.source).not.toContain("{#r2}");
    expect(after.flows[0]!.source).toContain("## Cart {#checkout.cart}\n\n- WHEN the user opens the cart THE SYSTEM SHALL list every item with its price. {#r1}");
    expect(after.ids).toEqual(["checkout", "checkout.cart", "checkout.cart/r1", "checkout.pay", "checkout.pay/r1", "checkout.pay/r2", "checkout.pay/r3", "checkout.failed"]);
    expect(after.views.map((v) => v.id)).toEqual(["v1", "v2", "v3", "v4"]);

    // r2 stays retired: the next requirement on pay is r4.
    const second = await ask(s, set.id, {
      reply: "Added.",
      requirements: [
        { op: "edit", flow: "checkout", edit: { op: "removeRequirement", node: "pay", tag: "r3" } },
        { op: "edit", flow: "checkout", edit: { op: "addRequirement", node: "pay", condition: "the card is expired", response: "ask for another card" } },
      ],
    });
    expect(second.messages[1]!.requirements!.changes).toEqual(["Removed checkout.pay/r3 (its id is retired)", "Added checkout.pay/r4"]);
    expect(second.requirementSet!.flows[0]!.source).toContain("ask for another card. {#r4}");

    // Undo the second change: the content goes back, r4 stays issued.
    const undo = await call(`/api/projects/${s.projectId}/coordinator/${second.messages[1]!.id}/undo`, s.cookie, { method: "POST" });
    expect(undo.status).toBe(200);
    const u = (await undo.json()) as Out;
    expect(u.messages[0]!.requirements!.undone).toBe(true);
    expect(u.requirementSet!.flows[0]!.source).toContain("{#r3}");
    expect(u.requirementSet!.ids).toContain("checkout.pay/r4");
    // The first change can no longer be undone: the set changed after it.
    expect((await call(`/api/projects/${s.projectId}/coordinator/${first.messages[1]!.id}/undo`, s.cookie, { method: "POST" })).status).toBe(409);

    // A retired step id cannot come back.
    const third = await ask(s, set.id, {
      reply: "Ok.",
      requirements: [
        { op: "edit", flow: "checkout", edit: { op: "removeStep", node: "failed" } },
        { op: "edit", flow: "checkout", edit: { op: "addStep", node: "failed", label: "Declined", from: "pay", edgeLabel: "declined" } },
      ],
    });
    expect(third.messages[1]!.requirements!.skipped).toEqual(["step id checkout.failed was used before; pick a new one"]);
  });

  it("changes nothing off a set page", async () => {
    const s = await seed();
    await withSet(s);
    answers = [JSON.stringify({ reply: "ok", requirements: [{ op: "title", text: "X" }] })];
    const out = (await (await call(`/api/projects/${s.projectId}/coordinator`, s.cookie, { method: "POST", json: { text: "x", screen: { route: "home" } } })).json()) as Out;
    expect(out.requirementSet).toBeNull();
    expect(out.messages[1]!.requirements).toBeNull();
  });
});
