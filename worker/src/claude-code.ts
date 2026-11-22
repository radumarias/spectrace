// Claude Code as the agent runtime, on the owner's own Claude subscription.
//
// The Claude Code CLI runs headless (`claude -p`) in a Cloudflare Container
// (`ClaudeCodeRunner`, image `containers/claude-code/Dockerfile`), signed in
// with a token from `claude setup-token` (`CLAUDE_CODE_OAUTH_TOKEN`). The
// Worker sends it a prompt and gets the result back. `CLAUDE_CODE_ORIGIN`
// points at a server run some other way instead (a local container, or a
// fake in tests).
//
// Anthropic's terms allow a person to sign in to the unmodified Claude Code
// binary with their own subscription, but not to route other people's
// requests through it. So the subscription is used only for the one GitHub
// login in `CLAUDE_CODE_OWNER`; everyone else uses their own API key
// (src/user-keys.ts) or the server's, through src/ai.ts.
import { createMessage } from "./ai";
import type { Bindings } from "./env";
import { AppError } from "./error";
import { log } from "./log";
import { userKey } from "./user-keys";

/** `claude-code`: the owner's subscription; `user_key`: the user's own API key; `api`: the server's API key. */
export type AgentBackend = "claude-code" | "user_key" | "api";

export interface ClaudeCodeRequest {
  prompt: string;
  model?: string;
  system?: string;
  /** Agent turns Claude Code may take (default 1: a single answer). */
  maxTurns?: number;
  /** Claude Code tools it may use without asking, such as "Read" or "Bash(git log:*)". None by default. */
  allowedTools?: string[];
  timeoutMs?: number;
}

export interface ClaudeCodeResult {
  result: string;
  isError: boolean;
  model: string | null;
  numTurns: number;
  durationMs: number;
  /** What the same run would have cost on the API; nothing is billed on a subscription. */
  costUsd: number;
}

/** The container's environment, from the Worker's secrets (see docs/deploy.md). */
export function claudeCodeEnv(env: Bindings): Record<string, string> {
  const out: Record<string, string> = {};
  if (env.CLAUDE_CODE_OAUTH_TOKEN) out.CLAUDE_CODE_OAUTH_TOKEN = env.CLAUDE_CODE_OAUTH_TOKEN;
  return out;
}

/** Whether a Claude Code server is reachable from here. */
export const claudeCodeOn = (env: Bindings) => !!env.CLAUDE_CODE_ORIGIN?.trim() || (!!env.CLAUDE_CODE && !!env.CLAUDE_CODE_OAUTH_TOKEN?.trim());

/** Whether work done for `login` may run on the subscription: only the owner's own work. */
export function subscriptionFor(env: Bindings, login: string): boolean {
  const owner = env.CLAUDE_CODE_OWNER?.trim().toLowerCase();
  return claudeCodeOn(env) && !!owner && owner === login.trim().toLowerCase();
}

async function claudeCodeFetch(env: Bindings, path: string, init: RequestInit): Promise<Response> {
  const origin = env.CLAUDE_CODE_ORIGIN?.trim().replace(/\/+$/, "");
  if (origin) return fetch(new Request(`${origin}${path}`, init));
  if (env.CLAUDE_CODE && env.CLAUDE_CODE_OAUTH_TOKEN) return env.CLAUDE_CODE.getByName("main").fetch(new Request(`http://claude-code${path}`, init));
  throw new AppError("not_configured", "Claude Code is not configured on this server (CLAUDE_CODE_OAUTH_TOKEN)");
}

/** One headless Claude Code run in the container. */
export async function runClaudeCode(env: Bindings, req: ClaudeCodeRequest): Promise<ClaudeCodeResult> {
  let res: Response;
  try {
    res = await claudeCodeFetch(env, "/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError("upstream", "Claude Code container request failed", { cause });
  }
  const body = (await res.json().catch(() => null)) as (ClaudeCodeResult & { error?: { code?: string; message?: string } }) | null;
  if (!res.ok || !body || typeof body.result !== "string") {
    log("error", "claude code run failed", { status: res.status, code: body?.error?.code, detail: body?.error?.message, model: req.model }, env.LOG_FORMAT);
    if (res.status === 503) throw new AppError("not_configured", "Claude Code has no credentials in its container");
    throw new AppError("upstream", `Claude Code answered ${res.status}`);
  }
  if (body.isError) {
    log("error", "claude code reported an error", { model: req.model, turns: body.numTurns }, env.LOG_FORMAT);
    throw new AppError("upstream", "Claude Code reported an error");
  }
  return body;
}

export interface AskRequest {
  model: string;
  prompt: string;
  system?: string;
  maxTokens: number;
}

export interface AskResult {
  backend: AgentBackend;
  model: string;
  text: string;
}

/**
 * One prompt, one answer, for work done on behalf of `user`: through Claude
 * Code on the subscription when they are its owner; else with their own API
 * key when they saved one; else with the server's API key. The last two go
 * through the Messages API and AI Gateway.
 */
export async function ask(env: Bindings, user: { id: string; login: string }, req: AskRequest): Promise<AskResult> {
  if (subscriptionFor(env, user.login)) {
    const out = await runClaudeCode(env, { prompt: req.prompt, model: req.model, system: req.system, maxTurns: 1 });
    return { backend: "claude-code", model: out.model ?? req.model, text: out.result.trim() };
  }
  const own = env.SECRETS_KEY ? await userKey(env, user.id) : null;
  const out = await createMessage(own ? { ...env, ANTHROPIC_API_KEY: own } : env, {
    model: req.model,
    max_tokens: req.maxTokens,
    messages: [{ role: "user", content: req.prompt }],
    ...(req.system ? { system: req.system } : {}),
  });
  return { backend: own ? "user_key" : "api", model: out.model, text: out.content.map((b) => b.text ?? "").join("").trim() };
}
