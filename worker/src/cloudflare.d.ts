/* eslint-disable @typescript-eslint/no-empty-object-type */
// Tells `cloudflare:workers` and `cloudflare:test` about our bindings and entry point.
import type { Bindings } from "./env";

declare global {
  namespace Cloudflare {
    interface Env extends Bindings {}
    interface GlobalProps {
      mainModule: typeof import("./index");
    }
  }
}
