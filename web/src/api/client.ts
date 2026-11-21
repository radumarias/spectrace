import createClient from "openapi-fetch";
import type { paths } from "./schema";

/** Typed client for the server. Types come from `schema.d.ts` (`just api-client`). */
export const api = createClient<paths>({
  // Absolute so `Request` accepts it everywhere (browser, jsdom); the dev server proxies /api.
  baseUrl: globalThis.location?.origin ?? "",
  // Look fetch up on every call so tests can replace it.
  fetch: (req) => globalThis.fetch(req),
});
