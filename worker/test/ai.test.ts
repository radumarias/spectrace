import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "../src/auth";
import { anthropicBaseUrl, createMessage, MODELS } from "../src/ai";

const call = (path: string, cookie?: string) =>
  exports.default.fetch(new Request(`http://spectrace.test${path}`, { headers: cookie ? { cookie } : {} }));

async function signedIn(): Promise<string> {
  const login = `ai-${crypto.randomUUID().slice(0, 8)}`;
  const userId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO users (id, github_id, login) VALUES (?1, ?2, ?3)").bind(userId, 5_000_000 + Math.floor(Math.random() * 1e6), login).run();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(crypto.randomUUID(), userId, await hashToken(login), new Date(Date.now() + 86_400_000).toISOString())
    .run();
  return `spectrace_session=${login}`;
}

const seen: { path: string; headers: Headers; body: string }[] = [];
function fakeAnthropic(status = 200) {
  const real = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    if (new URL(req.url).origin !== "http://anthropic.test") return real(input, init);
    seen.push({ path: new URL(req.url).pathname, headers: req.headers, body: String(init?.body ?? "") });
    if (status !== 200) return Response.json({ type: "error", error: { type: "authentication_error", message: "bad key sk-ant-SECRET" } }, { status });
    return Response.json({ id: "msg_1", model: MODELS.haiku, stop_reason: "end_turn", content: [{ type: "text", text: "OK" }], usage: { input_tokens: 12, output_tokens: 2 } });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  seen.length = 0;
  env.ANTHROPIC_API_KEY = undefined;
  env.CF_AIG_TOKEN = undefined;
});

describe("GET /api/ai/health", () => {
  it("needs a signed-in user", async () => {
    expect((await call("/api/ai/health")).status).toBe(401);
  });

  it("answers 503 until a key is configured", async () => {
    const res = await call("/api/ai/health", await signedIn());
    expect(res.status).toBe(503);
  });

  it("sends one haiku message with the key and gateway token, and reports the reply", async () => {
    env.ANTHROPIC_API_KEY = "sk-ant-test";
    env.CF_AIG_TOKEN = "aig-test";
    fakeAnthropic();
    const res = await call("/api/ai/health", await signedIn());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", model: "claude-haiku-5-5", gateway: "default", reply: "OK" });
    const sent = seen[0]!;
    expect(sent.path).toBe("/v1/messages");
    expect(sent.headers.get("x-api-key")).toBe("sk-ant-test");
    expect(sent.headers.get("cf-aig-authorization")).toBe("Bearer aig-test");
    expect((JSON.parse(sent.body) as { model: string }).model).toBe("claude-haiku-5-5");
  });

  it("works with only a gateway token (key stored in the gateway)", async () => {
    env.CF_AIG_TOKEN = "aig-test";
    fakeAnthropic();
    expect((await call("/api/ai/health", await signedIn())).status).toBe(200);
    expect(seen[0]!.headers.get("x-api-key")).toBeNull();
  });

  it("turns an Anthropic error into a 502 that leaks nothing", async () => {
    env.ANTHROPIC_API_KEY = "sk-ant-test";
    fakeAnthropic(401);
    const res = await call("/api/ai/health", await signedIn());
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("sk-ant");
  });
});

describe("gateway URL", () => {
  it("points at the account's AI Gateway Anthropic endpoint", () => {
    expect(anthropicBaseUrl({ AI_GATEWAY_ACCOUNT_ID: "acc1", AI_GATEWAY_ID: "spectrace" })).toBe("https://gateway.ai.cloudflare.com/v1/acc1/spectrace/anthropic");
    expect(anthropicBaseUrl({ AI_GATEWAY_ACCOUNT_ID: "acc1" })).toContain("/acc1/default/anthropic");
    expect(() => anthropicBaseUrl({})).toThrow(/AI Gateway is not configured/);
  });

  it("createMessage refuses without credentials", async () => {
    await expect(createMessage({ ANTHROPIC_BASE_URL: "http://anthropic.test" }, { model: MODELS.haiku, max_tokens: 1, messages: [] })).rejects.toThrow(/not configured/);
  });
});
