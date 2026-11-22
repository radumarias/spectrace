// Each user's own Anthropic API key (Radu's choice for how other users bring
// Claude, 2026-11-22). Stored encrypted with AES-GCM under SECRETS_KEY, a
// Worker secret holding 32 random bytes as base64. The plain key is only ever
// decrypted in memory to call Anthropic and is never returned or logged.
import type { Bindings } from "./env";
import { AppError } from "./error";

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function aesKey(env: Bindings): Promise<CryptoKey> {
  const raw = env.SECRETS_KEY?.trim();
  if (!raw) throw new AppError("not_configured", "Saving keys is not configured on this server (SECRETS_KEY)");
  let bytes: Uint8Array;
  try {
    bytes = unb64(raw);
  } catch {
    throw new AppError("not_configured", "SECRETS_KEY is not base64");
  }
  if (bytes.length !== 32) throw new AppError("not_configured", "SECRETS_KEY must be 32 bytes");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** `iv.ciphertext`, both base64. The user id is bound in as additional data, so a row copied to another user does not decrypt. */
export async function seal(env: Bindings, userId: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(userId) }, await aesKey(env), new TextEncoder().encode(plain));
  return `${b64(iv)}.${b64(new Uint8Array(ct))}`;
}

export async function unseal(env: Bindings, userId: string, sealed: string): Promise<string> {
  const [iv, ct] = sealed.split(".");
  if (!iv || !ct) throw new AppError("internal", "stored key is malformed");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv), additionalData: new TextEncoder().encode(userId) }, await aesKey(env), unb64(ct));
  return new TextDecoder().decode(pt);
}

/** Anthropic API keys start with `sk-ant-`. Subscription tokens (`sk-ant-oat…`) are refused. */
export function checkApiKey(key: string): string {
  const k = key.trim();
  if (/^sk-ant-oat/i.test(k)) throw AppError.badRequest("That is a Claude subscription token. Paste an API key from console.anthropic.com instead.");
  if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k)) throw AppError.badRequest("That does not look like an Anthropic API key (sk-ant-…).");
  return k;
}

export async function saveUserKey(env: Bindings, userId: string, key: string): Promise<string> {
  const k = checkApiKey(key);
  const hint = k.slice(-4);
  await env.DB.prepare(
    "INSERT INTO user_claude_keys (user_id, cipher, hint) VALUES (?1, ?2, ?3) ON CONFLICT (user_id) DO UPDATE SET cipher = excluded.cipher, hint = excluded.hint, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
  )
    .bind(userId, await seal(env, userId, k), hint)
    .run();
  return hint;
}

export async function deleteUserKey(env: Bindings, userId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM user_claude_keys WHERE user_id = ?1").bind(userId).run();
}

export async function userKeyHint(env: Bindings, userId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT hint FROM user_claude_keys WHERE user_id = ?1").bind(userId).first<{ hint: string }>();
  return row?.hint ?? null;
}

export async function userKey(env: Bindings, userId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT cipher FROM user_claude_keys WHERE user_id = ?1").bind(userId).first<{ cipher: string }>();
  return row ? unseal(env, userId, row.cipher) : null;
}
