import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "../src/auth";
import { MODELS } from "../src/ai";
import { seal, unseal } from "../src/user-keys";

const KEY = "sk-ant-api03-userownkey_0123456789abcdefWXYZ";

const call = (path: string, cookie: string, init: RequestInit = {}) =>
  exports.default.fetch(new Request(`http://spectrace.test${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } }));

async function signedIn(): Promise<{ id: string; login: string; cookie: string }> {
  const login = `uk-${crypto.randomUUID().slice(0, 8)}`;
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO users (id, github_id, login) VALUES (?1, ?2, ?3)").bind(id, 7_000_000 + Math.floor(Math.random() * 1e6), login).run();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(crypto.randomUUID(), id, await hashToken(login), new Date(Date.now() + 86_400_000).toISOString())
    .run();
  return { id, login, cookie: `spectrace_session=${login}` };
}

const sentKeys: (string | null)[] = [];
function fakeAnthropic() {
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    if (new URL(req.url).origin !== "http://anthropic.test") return real(input, init);
    sentKeys.push(req.headers.get("x-api-key"));
    return Response.json({ id: "m", model: MODELS.haiku, stop_reason: "end_turn", content: [{ type: "text", text: "OK" }], usage: { input_tokens: 1, output_tokens: 1 } });
  });
}

const put = (cookie: string, apiKey: string) => call("/api/me/claude", cookie, { method: "PUT", body: JSON.stringify({ apiKey }) });
const SECRETS_KEY = env.SECRETS_KEY;

afterEach(() => {
  vi.restoreAllMocks();
  sentKeys.length = 0;
  env.ANTHROPIC_API_KEY = undefined;
  env.SECRETS_KEY = SECRETS_KEY;
});

describe("/api/me/claude", () => {
  it("needs a signed-in user", async () => {
    expect((await exports.default.fetch(new Request("http://spectrace.test/api/me/claude"))).status).toBe(401);
  });

  it("reports the server key, then the user's own key once saved, and never returns the key", async () => {
    const me = await signedIn();
    expect(await (await call("/api/me/claude", me.cookie)).json()).toEqual({ using: "none", keyHint: null, canSave: true });
    env.ANTHROPIC_API_KEY = "sk-ant-server";
    expect(await (await call("/api/me/claude", me.cookie)).json()).toMatchObject({ using: "server_key" });

    const res = await put(me.cookie, ` ${KEY} `);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("userownkey");
    expect(JSON.parse(text)).toEqual({ using: "own_key", keyHint: "WXYZ", canSave: true });

    const row = await env.DB.prepare("SELECT cipher FROM user_claude_keys WHERE user_id = ?1").bind(me.id).first<{ cipher: string }>();
    expect(row!.cipher).not.toContain("sk-ant");
  });

  it("refuses subscription tokens and things that are not API keys", async () => {
    const me = await signedIn();
    const oat = await put(me.cookie, "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz");
    expect(oat.status).toBe(400);
    expect(await oat.text()).toContain("subscription token");
    expect((await put(me.cookie, "hello")).status).toBe(400);
  });

  it("answers 503 when the server cannot save keys", async () => {
    const me = await signedIn();
    env.SECRETS_KEY = undefined;
    expect((await put(me.cookie, KEY)).status).toBe(503);
  });

  it("uses the user's own key for their agent work, and the server's again after removing it", async () => {
    const me = await signedIn();
    env.ANTHROPIC_API_KEY = "sk-ant-server";
    fakeAnthropic();
    await put(me.cookie, KEY);
    expect(await (await call("/api/ai/health", me.cookie)).json()).toMatchObject({ backend: "user_key" });
    expect(sentKeys).toEqual([KEY]);

    const del = await call("/api/me/claude", me.cookie, { method: "DELETE" });
    expect(await del.json()).toMatchObject({ using: "server_key", keyHint: null });
    expect(await (await call("/api/ai/health", me.cookie)).json()).toMatchObject({ backend: "api" });
    expect(sentKeys).toEqual([KEY, "sk-ant-server"]);
  });
});

describe("sealing", () => {
  it("round-trips, and a sealed key only opens for its own user", async () => {
    const sealed = await seal(env, "u1", KEY);
    expect(await unseal(env, "u1", sealed)).toBe(KEY);
    await expect(unseal(env, "u2", sealed)).rejects.toThrow();
  });
});
