/* eslint-disable no-console -- a CLI script */
// Prints the OpenAPI document to stdout. Used by `just api-client`; needs no D1 or secrets.
// With `--check` it compares against web/openapi.json instead and fails when that is stale.
import { readFileSync } from "node:fs";
import { createApp } from "../src/app";

// Request logging writes to stdout; keep stdout for the JSON.
console.log = console.error;

const res = await createApp().request("/api/openapi.json");
if (!res.ok) throw new Error(`openapi.json answered ${res.status}`);
const json = `${JSON.stringify(await res.json(), null, 2)}\n`;

if (process.argv.includes("--check")) {
  const committed = readFileSync(new URL("../../web/openapi.json", import.meta.url), "utf8");
  if (committed !== json) {
    process.stderr.write("web/openapi.json is stale: run `just api-client`\n");
    process.exit(1);
  }
} else {
  process.stdout.write(json);
}
