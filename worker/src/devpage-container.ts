// The devpage server container (see src/devpage.ts). Its own module, imported
// only by src/index.ts, so the OpenAPI script (Node) never loads the
// containers runtime.
import { Container } from "@cloudflare/containers";
import { devpageEnv } from "./devpage";
import type { Bindings } from "./env";

export class DevpageServer extends Container<Bindings> {
  defaultPort = 3030;
  sleepAfter = "30m";
  envVars = devpageEnv(this.env);
}
