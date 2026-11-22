// The Claude Code container (see src/claude-code.ts). Its own module, imported
// only by src/index.ts, so the OpenAPI script (Node) never loads the
// containers runtime.
import { Container } from "@cloudflare/containers";
import { claudeCodeEnv } from "./claude-code";
import type { Bindings } from "./env";

export class ClaudeCodeRunner extends Container<Bindings> {
  defaultPort = 8080;
  sleepAfter = "10m";
  envVars = claudeCodeEnv(this.env);
}
