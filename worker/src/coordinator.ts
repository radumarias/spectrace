// The coordinator (T7.1): the main agent a user chats with in the app.
//
// One answer is a short tool loop. Each round sends the conversation, the
// screen the user is on and the tool results so far to Claude through `ask()`
// (Claude Code on the owner's subscription, else the user's own API key, else
// the server's), and Claude answers with one JSON object: either tools to
// call, or the reply. Tools only read, through the app's own API with the
// user's session, so the coordinator sees exactly what the user may see.
// Anything that changes something (merge, approve, start an agent) comes back
// as a proposed action that runs only when the user clicks it.
//
// The same JSON protocol works on both backends: Claude Code's `claude -p`
// has no way to call the Worker's tools, so tools are not native tool use.
import { MODELS } from "./ai";
import { type AgentBackend, ask } from "./claude-code";
import { log } from "./log";

/** What the user is looking at, sent with each message. */
export interface Screen {
  route: string;
  pullId?: string;
  specId?: string;
  boardId?: string;
}

/** Reads one API path as the user: `null` body and the status when it fails. */
export type ApiGet = (path: string) => Promise<{ status: number; body: unknown }>;

export interface ToolCall {
  name: string;
  args: Record<string, string>;
}

/** An action the coordinator proposes; it runs only on the user's click. */
export interface Action {
  kind: ActionKind;
  label: string;
  pullId?: string;
  path?: string;
}

export const ACTION_KINDS = ["open", "review_pull", "approve_pull", "merge_pull", "sync_pulls", "reindex"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** The other agents the coordinator can hand work to, by action kind. */
export const AGENTS: { kind: ActionKind; name: string; does: string }[] = [
  { kind: "review_pull", name: "Reviewer", does: "reviews a pull request against its specs and writes findings and a walkthrough" },
  { kind: "sync_pulls", name: "Sync", does: "pulls the latest pull requests, reviews and checks from GitHub" },
  { kind: "reindex", name: "Indexer", does: "indexes the project's specs and code again" },
];

const enc = (s: string) => encodeURIComponent(s);

interface Tool {
  name: string;
  args: string;
  does: string;
  run(get: ApiGet, projectId: string, args: Record<string, string>): Promise<unknown>;
}

type PullLite = { id: string; repo: string; number: number; title: string; author: string; state: string; draft: boolean; needsYou: boolean; testsTotal: number; testsPassed: number; testsFailed: number; updatedAt: string };

const pick = <T extends object, K extends keyof T>(o: T, keys: K[]): Pick<T, K> => Object.fromEntries(keys.map((k) => [k, o[k]])) as Pick<T, K>;

async function must(get: ApiGet, path: string): Promise<unknown> {
  const r = await get(path);
  if (r.status >= 400) return { error: `HTTP ${r.status}`, detail: r.body };
  return r.body;
}

/** A pull request by id, or by number ("142", "#142", "shop#142"). */
async function resolvePull(get: ApiGet, projectId: string, ref: string): Promise<string | null> {
  const m = /^(?:([\w.-]+\/)?([\w.-]+)#|#)?(\d+)$/.exec(ref.trim());
  if (!m) return ref.trim() || null;
  const r = await get(`/api/projects/${enc(projectId)}/pulls?filter=all&limit=200`);
  const pulls = ((r.body as { pulls?: PullLite[] } | null)?.pulls ?? []).filter((p) => p.number === Number(m[3]) && (!m[2] || p.repo.endsWith(`/${m[2]}`) || p.repo === `${m[1] ?? ""}${m[2]}`));
  return pulls[0]?.id ?? null;
}

type AgentReview = { state: string; findings?: { severity?: string; status?: string }[] } | null;

/** The merge gates, as the PR page shows them. */
function gates(pull: { checksState: string }, approved: boolean, review: AgentReview) {
  const done = review?.state === "succeeded";
  const open = (review?.findings ?? []).filter((f) => ["high", "medium"].includes(f.severity ?? "") && !["fixed", "dismissed", "resolved"].includes(f.status ?? "")).length;
  return [
    { gate: "Agent review finished", state: done ? "ok" : review ? `open (review ${review.state})` : "not checked yet (no agent review started)" },
    { gate: "No open high or medium findings", state: done ? (open ? `open (${open} findings)` : "ok") : "not checked yet" },
    { gate: "Every changed file mapped to a spec", state: "not checked yet" },
    { gate: "Tests pass", state: pull.checksState === "passing" || pull.checksState === "none" ? "ok" : pull.checksState === "pending" ? "open (tests running)" : "open (tests failing)" },
    { gate: "Your approval", state: approved ? "ok" : "open" },
  ];
}

export const TOOLS: Tool[] = [
  {
    name: "project.get",
    args: "",
    does: "the project: name, context, repos and their index state",
    run: async (get, p) => {
      const b = (await must(get, `/api/projects/${enc(p)}`)) as Record<string, unknown>;
      return b && "repos" in b ? { name: b.name, context: b.context, repos: (b.repos as Record<string, unknown>[]).map((r) => pick(r, ["full_name", "index_state", "index_error"] as never[])) } : b;
    },
  },
  {
    name: "pulls.list",
    args: "filter: needs | open | merged | all (default needs)",
    does: "the pull request inbox; `needs` is what waits on the user",
    run: async (get, p, a) => {
      const filter = ["needs", "open", "merged", "all"].includes(a.filter ?? "") ? a.filter : "needs";
      const b = (await must(get, `/api/projects/${enc(p)}/pulls?filter=${filter}&limit=30`)) as { pulls?: PullLite[]; counts?: unknown };
      if (!b?.pulls) return b;
      return { counts: b.counts, pulls: b.pulls.map((x) => pick(x, ["id", "repo", "number", "title", "author", "state", "draft", "needsYou", "testsTotal", "testsPassed", "testsFailed", "updatedAt"])) };
    },
  },
  {
    name: "pull.get",
    args: "pull: a pull request id, or its number like 142",
    does: "one pull request: description, files, CI checks, your reviews and its merge gates",
    run: async (get, p, a) => {
      const id = await resolvePull(get, p, a.pull ?? "");
      if (!id) return { error: `no pull request ${a.pull ?? ""}` };
      const b = (await must(get, `/api/projects/${enc(p)}/pulls/${enc(id)}`)) as Record<string, unknown> & { checksState?: string; headSha?: string; body?: string };
      if (!b || "error" in b) return b;
      const rv = (await get(`/api/projects/${enc(p)}/pulls/${enc(id)}/reviews`)).body as { reviews?: { verdict: string; headSha: string }[] } | null;
      const approved = rv?.reviews?.[0]?.verdict === "approved" && rv.reviews[0].headSha === b.headSha;
      const ar = await get(`/api/projects/${enc(p)}/pulls/${enc(id)}/agent-review`);
      const review = ar.status === 200 ? ((ar.body as { review?: AgentReview } | null)?.review ?? null) : null;
      return { ...b, body: String(b.body ?? "").slice(0, 3000), gates: gates({ checksState: b.checksState ?? "none" }, approved, review) };
    },
  },
  {
    name: "pull.review",
    args: "pull: a pull request id, or its number",
    does: "the Reviewer agent's latest review of a pull request: state, walkthrough and findings (null when none was started)",
    run: async (get, p, a) => {
      const id = await resolvePull(get, p, a.pull ?? "");
      if (!id) return { error: `no pull request ${a.pull ?? ""}` };
      const r = await get(`/api/projects/${enc(p)}/pulls/${enc(id)}/agent-review`);
      if (r.status === 404) return { review: null, note: "agent review is not available on this server yet" };
      return r.status >= 400 ? { error: `HTTP ${r.status}` } : r.body;
    },
  },
  {
    name: "pull.diff",
    args: "pull: a pull request id, or its number",
    does: "the unified diff of a pull request (cut at 12,000 characters)",
    run: async (get, p, a) => {
      const id = await resolvePull(get, p, a.pull ?? "");
      if (!id) return { error: `no pull request ${a.pull ?? ""}` };
      const b = (await must(get, `/api/projects/${enc(p)}/pulls/${enc(id)}/diff`)) as { files?: { path: string; patch: string | null }[] };
      if (!b?.files) return b;
      let left = 12_000;
      return {
        files: b.files.map((f) => {
          const patch = (f.patch ?? "").slice(0, Math.max(0, left));
          left -= patch.length;
          return { path: f.path, patch: patch || null };
        }),
      };
    },
  },
  {
    name: "specs.list",
    args: "",
    does: "the project's specs: repo, path, title, steps, requirements, how many are tested",
    run: (get, p) => must(get, `/api/projects/${enc(p)}/specs`),
  },
  {
    name: "spec.get",
    args: "spec: a spec id",
    does: "one spec: source, parsed steps and requirements, and the code and tests anchored to it",
    run: async (get, p, a) => {
      const b = (await must(get, `/api/projects/${enc(p)}/specs/${enc(a.spec ?? "")}`)) as Record<string, unknown>;
      return b && typeof b.source === "string" ? { ...b, source: b.source.slice(0, 8000) } : b;
    },
  },
  {
    name: "jobs.list",
    args: "",
    does: "what the agents and background jobs are doing: the 50 latest jobs and their state",
    run: (get, p) => must(get, `/api/projects/${enc(p)}/jobs`),
  },
];

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

/** How a tool call shows under the reply: `pulls.list(filter=needs)`. */
export const callLabel = (c: ToolCall) => `${c.name}(${Object.entries(c.args).map(([k, v]) => `${k}=${v}`).join(", ")})`;

const ROUTES = "/home (inbox), /prs (pull requests), /pr/<pull id>, /spec (specs), /spec/<spec id>, /map (app map), /board (whiteboard), /agents, /runners, /project (project settings)";

export function systemPrompt(): string {
  return [
    "You are the coordinator in spectrace, a spec-driven pull request review app. You are the main agent the user chats with.",
    "You answer questions about their project, pull requests, merge gates, specs and agents, and you hand work to other agents.",
    "Be brief and concrete: two to four short sentences, plain text, no markdown headings. Use the user's words. Never invent data: call a tool when you need facts.",
    "",
    "Answer with exactly one JSON object and nothing else, in one of two shapes:",
    '1. To read data: {"tools":[{"name":"<tool>","args":{"<arg>":"<value>"}}]} (one to four calls; you get the results back).',
    '2. To answer: {"reply":"<text>","actions":[{"kind":"<kind>","label":"<button text>","pullId":"<id>","path":"<route>"}]} (actions optional, at most two).',
    "",
    "Tools (read only):",
    ...TOOLS.map((t) => `- ${t.name}(${t.args}): ${t.does}`),
    "",
    "Actions are buttons the user must click; you never run them yourself. Propose one only when it is the obvious next step.",
    `- open: go to a screen. path is one of ${ROUTES}.`,
    "- approve_pull: approve the pull request (pullId). - merge_pull: merge it (pullId), only when every checked gate is ok.",
    ...AGENTS.map((a) => `- ${a.kind}: start the ${a.name} agent, which ${a.does}${a.kind === "review_pull" ? " (pullId)" : ""}.`),
    "Use ids from tool results for pullId, never a PR number.",
  ].join("\n");
}

export interface Turn {
  role: "user" | "coordinator";
  text: string;
}

function screenLine(s: Screen): string {
  const parts = [`route=${s.route}`];
  if (s.pullId) parts.push(`pull id=${s.pullId}`);
  if (s.specId) parts.push(`spec id=${s.specId}`);
  if (s.boardId) parts.push(`board id=${s.boardId}`);
  return parts.join(", ");
}

export function buildPrompt(o: { projectName: string; history: Turn[]; question: string; screen: Screen; results: { call: ToolCall; result: unknown }[]; last: boolean }): string {
  const lines = [`Project: ${o.projectName}`, `The user is on: ${screenLine(o.screen)}`];
  if (o.history.length) {
    lines.push("", "Conversation so far:");
    for (const t of o.history) lines.push(`${t.role === "user" ? "User" : "Coordinator"}: ${t.text}`);
  }
  lines.push("", `User: ${o.question}`);
  if (o.results.length) {
    lines.push("", "Tool results:");
    for (const r of o.results) lines.push(`${callLabel(r.call)} -> ${JSON.stringify(r.result).slice(0, 16_000)}`);
  }
  lines.push("", o.last ? "Answer now with the reply shape; no more tools." : "Answer with one JSON object.");
  return lines.join("\n");
}

export type Parsed = { kind: "tools"; calls: ToolCall[] } | { kind: "reply"; text: string; actions: Action[] };

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

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);

function cleanAction(a: unknown): Action | null {
  if (!a || typeof a !== "object") return null;
  const o = a as Record<string, unknown>;
  const kind = str(o.kind) as ActionKind | undefined;
  if (!kind || !ACTION_KINDS.includes(kind)) return null;
  const label = (str(o.label) ?? "").trim().slice(0, 60);
  const pullId = str(o.pullId)?.trim();
  const path = str(o.path)?.trim();
  if (["review_pull", "approve_pull", "merge_pull"].includes(kind)) {
    if (!pullId || !/^[A-Za-z0-9-]{1,64}$/.test(pullId)) return null;
    return { kind, label: label || defaultLabel(kind), pullId };
  }
  if (kind === "open") {
    if (!path || !/^\/(home|prs|pr\/[A-Za-z0-9-]{1,64}|spec(\/[A-Za-z0-9-]{1,64})?|map|board(\/[A-Za-z0-9-]{1,64})?|agents|runners|project|talk)$/.test(path)) return null;
    return { kind, label: label || "Open", path };
  }
  return { kind, label: label || defaultLabel(kind) };
}

function defaultLabel(kind: ActionKind): string {
  return { open: "Open", review_pull: "Start agent review", approve_pull: "Approve", merge_pull: "Merge", sync_pulls: "Pull from GitHub", reindex: "Re-index" }[kind];
}

/** Reads Claude's answer. Anything that is not the JSON protocol is taken as a plain reply. */
export function parseAnswer(text: string): Parsed {
  const raw = firstObject(text);
  let o: Record<string, unknown> | null = null;
  if (raw) {
    try {
      o = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      o = null;
    }
  }
  if (o && Array.isArray(o.tools) && o.tools.length) {
    const calls = o.tools
      .map((t): ToolCall | null => {
        const r = (t ?? {}) as Record<string, unknown>;
        const name = str(r.name);
        if (!name || !TOOL_NAMES.has(name)) return null;
        const args: Record<string, string> = {};
        for (const [k, v] of Object.entries((r.args ?? {}) as Record<string, unknown>)) {
          const s = str(v);
          if (s !== undefined) args[k] = s.slice(0, 200);
        }
        return { name, args };
      })
      .filter((c): c is ToolCall => c !== null)
      .slice(0, 4);
    if (calls.length) return { kind: "tools", calls };
  }
  if (o && typeof o.reply === "string") {
    const actions = (Array.isArray(o.actions) ? o.actions : []).map(cleanAction).filter((a): a is Action => a !== null).slice(0, 2);
    return { kind: "reply", text: o.reply.trim(), actions };
  }
  return { kind: "reply", text: text.trim(), actions: [] };
}

export interface Answer {
  text: string;
  tools: string[];
  actions: Action[];
  backend: AgentBackend;
}

export const MAX_ROUNDS = 4;

/** Answers one user message: up to MAX_ROUNDS model calls, with read tools between them. */
export async function answer(
  env: Parameters<typeof ask>[0],
  user: { id: string; login: string },
  o: { projectId: string; projectName: string; history: Turn[]; question: string; screen: Screen; get: ApiGet },
): Promise<Answer> {
  const results: { call: ToolCall; result: unknown }[] = [];
  let backend: AgentBackend = "api";
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const last = round === MAX_ROUNDS;
    const out = await ask(env, user, {
      model: MODELS.sonnet,
      maxTokens: 1200,
      system: systemPrompt(),
      prompt: buildPrompt({ projectName: o.projectName, history: o.history, question: o.question, screen: o.screen, results, last }),
    });
    backend = out.backend;
    const parsed = parseAnswer(out.text);
    if (parsed.kind === "reply" || last) {
      const reply = parsed.kind === "reply" ? parsed : { text: "I could not finish looking that up. Try asking it a narrower way.", actions: [] };
      return { text: reply.text || "…", tools: results.map((r) => callLabel(r.call)), actions: reply.actions, backend };
    }
    for (const call of parsed.calls) {
      const tool = TOOLS.find((t) => t.name === call.name);
      let result: unknown;
      try {
        result = tool ? await tool.run(o.get, o.projectId, call.args) : { error: "unknown tool" };
      } catch (cause) {
        log("warn", "coordinator tool failed", { tool: call.name, cause: String(cause) }, env.LOG_FORMAT);
        result = { error: "the tool failed" };
      }
      results.push({ call, result });
    }
  }
  /* c8 ignore next */
  return { text: "…", tools: [], actions: [], backend };
}
