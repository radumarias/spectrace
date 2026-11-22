// HTTP front door for Claude Code inside the container (no dependencies).
//
//   GET  /health  -> { status: "ok", version, auth: "subscription" | "api_key" | "none" }
//   POST /run     <- { prompt, model?, system?, maxTurns?, allowedTools?, timeoutMs? }
//                 -> { result, isError, model, numTurns, durationMs, costUsd, usage, sessionId }
//
// Each run is one `claude -p --output-format json` in its own empty folder
// under /work, removed afterwards. The prompt goes in on stdin, never on the
// command line. Credentials come from the container's environment and are
// never logged or returned.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const PORT = Number(process.env.PORT || 8080);
const MAX_PARALLEL = Number(process.env.CLAUDE_CODE_MAX_PARALLEL || 2);
const MAX_BODY = 1 << 20;
const WORK_DIR = process.env.WORK_DIR || "/work";
let running = 0;

const auth = () => (process.env.CLAUDE_CODE_OAUTH_TOKEN ? "subscription" : process.env.ANTHROPIC_API_KEY ? "api_key" : "none");

let version = "unknown";
try {
  version = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
} catch {
  // reported as "unknown"
}

function childEnv() {
  const env = { ...process.env };
  // The subscription token wins: with both set, Claude Code would otherwise prefer the API key.
  if (env.CLAUDE_CODE_OAUTH_TOKEN) delete env.ANTHROPIC_API_KEY;
  return env;
}

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) reject(new Error("body too large"));
      else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("body is not JSON"));
      }
    });
    req.on("error", reject);
  });
}

const TOOL = /^[A-Za-z0-9_*:().\- /]+$/;

function argsFor(body) {
  const args = ["-p", "--output-format", "json"];
  if (body.model) args.push("--model", String(body.model));
  args.push("--max-turns", String(Math.max(1, Math.min(200, Number(body.maxTurns) || 1))));
  if (body.system) args.push("--append-system-prompt", String(body.system));
  const tools = Array.isArray(body.allowedTools) ? body.allowedTools.map(String).filter((t) => TOOL.test(t)) : [];
  if (tools.length) args.push("--allowedTools", tools.join(","));
  return args;
}

function run(body) {
  return new Promise((resolve) => {
    const cwd = mkdtempSync(join(WORK_DIR, "run-"));
    const child = spawn("claude", argsFor(body), { cwd, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timeout = Math.max(5_000, Math.min(30 * 60_000, Number(body.timeoutMs) || 10 * 60_000));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      rmSync(cwd, { recursive: true, force: true });
      resolve({ code, signal, out, err });
    });
    child.stdin.end(String(body.prompt));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { status: "ok", version, auth: auth() });
  if (req.method !== "POST" || url.pathname !== "/run") return send(res, 404, { error: { code: "not_found", message: "not found" } });
  if (auth() === "none") return send(res, 503, { error: { code: "not_configured", message: "no CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in the container" } });

  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return send(res, 400, { error: { code: "bad_request", message: String(e.message) } });
  }
  if (typeof body?.prompt !== "string" || !body.prompt.trim()) return send(res, 400, { error: { code: "bad_request", message: "prompt is required" } });
  if (running >= MAX_PARALLEL) return send(res, 429, { error: { code: "busy", message: "Claude Code is busy, try again" } });

  running++;
  try {
    const r = await run(body);
    let parsed;
    try {
      parsed = JSON.parse(r.out);
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.type !== "result") {
      // stderr may hold anything the CLI printed; keep only its first lines and never the environment.
      console.error(JSON.stringify({ msg: "claude run failed", code: r.code, signal: r.signal, stderr: r.err.slice(0, 2000) }));
      return send(res, 502, { error: { code: "upstream", message: r.signal ? "Claude Code timed out" : `Claude Code exited with ${r.code}` } });
    }
    const model = Object.keys(parsed.modelUsage ?? {})[0] ?? body.model ?? null;
    return send(res, 200, {
      result: parsed.result ?? "",
      isError: !!parsed.is_error,
      subtype: parsed.subtype ?? null,
      model,
      numTurns: parsed.num_turns ?? 0,
      durationMs: parsed.duration_ms ?? 0,
      costUsd: parsed.total_cost_usd ?? 0,
      usage: parsed.usage ?? {},
      sessionId: parsed.session_id ?? null,
    });
  } finally {
    running--;
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(JSON.stringify({ msg: "claude-code server listening", port: PORT, version, auth: auth() })));
