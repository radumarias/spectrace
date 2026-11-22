import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "../src/auth";
import { MODELS } from "../src/ai";
import { claudeCodeEnv, runClaudeCode, subscriptionFor } from "../src/claude-code";
import type { Bindings } from "../src/env";

const call = (path: string, cookie: string) => exports.default.fetch(new Request(`http://spectrace.test${path}`, { headers: { cookie } }));

async function signedIn(login = `cc-${crypto.randomUUID().slice(0, 8)}`): Promise<{ login: string; cookie: string }> {
  const userId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO users (id, github_id, login) VALUES (?1, ?2, ?3)").bind(userId, 6_000_000 + Math.floor(Math.random() * 1e6), login).run();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(crypto.randomUUID(), userId, await hashToken(login), new Date(Date.now() + 86_400_000).toISOString())
    .run();
  return { login, cookie: `spectrace_session=${login}` };
}

type Seen = { origin: string; path: string; body: string };
const seen: Seen[] = [];

/** Fakes the Claude Code container (`http://claude-code.test`) and Anthropic (`http://anthropic.test`). */
function fakeUpstreams(container: { status?: number; body?: unknown } = {}) {
  const real = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    if (url.origin === "http://claude-code.test") {
      seen.push({ origin: url.origin, path: url.pathname, body: await req.text() });
      const body = container.body ?? { result: "OK\n", isError: false, model: MODELS.haiku, numTurns: 1, durationMs: 900, costUsd: 0.0001, usage: {}, sessionId: "s1" };
      return Response.json(body, { status: container.status ?? 200 });
    }
    if (url.origin === "http://anthropic.test") {
      seen.push({ origin: url.origin, path: url.pathname, body: await req.text() });
      return Response.json({ id: "msg_1", model: MODELS.haiku, stop_reason: "end_turn", content: [{ type: "text", text: "OK" }], usage: { input_tokens: 12, output_tokens: 2 } });
    }
    return real(input, init);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  seen.length = 0;
  env.CLAUDE_CODE_OWNER = undefined;
  env.ANTHROPIC_API_KEY = undefined;
});

describe("GET /api/ai/health with Claude Code", () => {
  it("runs the owner's message through Claude Code, not the API", async () => {
    const me = await signedIn();
    env.CLAUDE_CODE_OWNER = me.login.toUpperCase();
    env.ANTHROPIC_API_KEY = "sk-ant-test";
    fakeUpstreams();
    const res = await call("/api/ai/health", me.cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "ok", backend: "claude-code", model: "claude-haiku-5-5", reply: "OK" });
    expect(body.gateway).toBeUndefined();
    expect(seen.map((s) => `${s.origin}${s.path}`)).toEqual(["http://claude-code.test/run"]);
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ prompt: "Reply with the single word OK.", model: "claude-haiku-5-5", maxTurns: 1 });
  });

  it("sends everyone else through the API key, never the subscription", async () => {
    const owner = await signedIn();
    const other = await signedIn();
    env.CLAUDE_CODE_OWNER = owner.login;
    env.ANTHROPIC_API_KEY = "sk-ant-test";
    fakeUpstreams();
    const res = await call("/api/ai/health", other.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ backend: "api", gateway: "default" });
    expect(seen.map((s) => s.origin)).toEqual(["http://anthropic.test"]);
  });

  it("answers 503 when the container has no credentials", async () => {
    const me = await signedIn();
    env.CLAUDE_CODE_OWNER = me.login;
    fakeUpstreams({ status: 503, body: { error: { code: "not_configured", message: "no token" } } });
    expect((await call("/api/ai/health", me.cookie)).status).toBe(503);
  });

  it("turns a failed or errored run into a 502 that leaks nothing", async () => {
    const me = await signedIn();
    env.CLAUDE_CODE_OWNER = me.login;
    fakeUpstreams({ status: 502, body: { error: { code: "upstream", message: "token sk-ant-oat-SECRET rejected" } } });
    const res = await call("/api/ai/health", me.cookie);
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("SECRET");

    vi.restoreAllMocks();
    fakeUpstreams({ body: { result: "rate limited", isError: true, model: null, numTurns: 1, durationMs: 1, costUsd: 0 } });
    expect((await call("/api/ai/health", me.cookie)).status).toBe(502);
  });
});

describe("subscription rules", () => {
  const base = { CLAUDE_CODE_ORIGIN: "http://claude-code.test" } as Bindings;

  it("is only for the configured owner, case-insensitively", () => {
    expect(subscriptionFor({ ...base, CLAUDE_CODE_OWNER: "Radu" }, "radu")).toBe(true);
    expect(subscriptionFor({ ...base, CLAUDE_CODE_OWNER: "radu" }, "someone")).toBe(false);
    expect(subscriptionFor(base, "radu")).toBe(false);
    expect(subscriptionFor({ CLAUDE_CODE_OWNER: "radu" } as Bindings, "radu")).toBe(false);
  });

  it("passes only the subscription token to the container", () => {
    expect(claudeCodeEnv({ CLAUDE_CODE_OAUTH_TOKEN: "oat", ANTHROPIC_API_KEY: "sk", GITHUB_CLIENT_SECRET: "x" } as Bindings)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "oat" });
    expect(claudeCodeEnv({} as Bindings)).toEqual({});
  });

  it("refuses without a container or origin", async () => {
    await expect(runClaudeCode({ CLAUDE_CODE_OWNER: "radu" } as Bindings, { prompt: "hi" })).rejects.toThrow(/not configured/);
  });
});
