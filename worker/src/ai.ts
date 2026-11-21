import type { Bindings } from "./env";
import { AppError } from "./error";
import { log } from "./log";

/** Latest Claude models. Pick by job: Haiku for simple, Sonnet for most, Opus for the hardest. */
export const MODELS = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
} as const;

export interface MessageRequest {
  model: string;
  max_tokens: number;
  messages: { role: "user" | "assistant"; content: string }[];
  system?: string;
}

export interface MessageResponse {
  id: string;
  model: string;
  stop_reason: string | null;
  content: { type: string; text?: string }[];
  usage: { input_tokens: number; output_tokens: number };
}

type AiEnv = Pick<Bindings, "ANTHROPIC_API_KEY" | "CF_AIG_TOKEN" | "AI_GATEWAY_ACCOUNT_ID" | "AI_GATEWAY_ID" | "ANTHROPIC_BASE_URL" | "LOG_FORMAT">;

/** Where Anthropic requests go: AI Gateway's Anthropic endpoint, unless `ANTHROPIC_BASE_URL` overrides it (tests). */
export function anthropicBaseUrl(env: AiEnv): string {
  if (env.ANTHROPIC_BASE_URL?.trim()) return env.ANTHROPIC_BASE_URL.trim().replace(/\/+$/, "");
  const account = env.AI_GATEWAY_ACCOUNT_ID?.trim();
  if (!account) throw new AppError("not_configured", "AI Gateway is not configured on this server (AI_GATEWAY_ACCOUNT_ID)");
  return `https://gateway.ai.cloudflare.com/v1/${account}/${env.AI_GATEWAY_ID?.trim() || "default"}/anthropic`;
}

export function gatewayName(env: AiEnv): string {
  return env.AI_GATEWAY_ID?.trim() || "default";
}

/**
 * Call the Anthropic Messages API through AI Gateway.
 *
 * Auth is a standard Anthropic API key (`ANTHROPIC_API_KEY`, sent as `x-api-key`). If the gateway
 * itself requires authentication, `CF_AIG_TOKEN` is sent as `cf-aig-authorization`; with a key
 * stored in the gateway (BYOK) that token alone is enough. Neither value is ever logged.
 * Claude Pro/Max subscription tokens are deliberately not supported: Anthropic does not allow them in third-party services.
 */
export async function createMessage(env: AiEnv, req: MessageRequest): Promise<MessageResponse> {
  const key = env.ANTHROPIC_API_KEY?.trim();
  const aig = env.CF_AIG_TOKEN?.trim();
  if (!key && !aig) throw new AppError("not_configured", "Anthropic is not configured on this server (ANTHROPIC_API_KEY)");
  const url = `${anthropicBaseUrl(env)}/v1/messages`;
  const headers: Record<string, string> = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
  if (key) headers["x-api-key"] = key;
  if (aig) headers["cf-aig-authorization"] = `Bearer ${aig}`;

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(req) });
  } catch (cause) {
    throw new AppError("upstream", "AI Gateway request failed", { cause });
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { type?: string; message?: string } } | null;
    log("error", "anthropic request failed", { status: res.status, type: body?.error?.type, detail: body?.error?.message, model: req.model }, env.LOG_FORMAT);
    throw new AppError("upstream", `Anthropic answered ${res.status}`);
  }
  return (await res.json()) as MessageResponse;
}
