# spectrace

Spec-driven PR review and agent orchestration. One Cloudflare Worker (TypeScript) owns the data and talks to GitHub; agents run as Pi Durable sessions, and model calls go through Cloudflare AI Gateway. The web app only talks to the Worker, from the same origin.

Plan: https://claude.ai/artifact/Ko3v3QgPX2n2PhGZFt8Gnh
UI reference prototype: https://claude.ai/artifact/E53sDphecfigvdt7Kk82Mx

## Layout

| Path | What it is |
|---|---|
| `worker/` | REST API, GitHub webhooks, job queue, live events (TypeScript, Hono + zod-openapi, D1, Queues, Durable Objects, WebSockets). Entry `src/index.ts`, routes in `src/routes/`, SQL migrations in `migrations/`, bindings in `wrangler.toml` |
| `crates/core` | Spec parsing, spec index, file-to-spec mapping, gate rules. No I/O. Compiled to WASM for the Worker (T0.9) |
| `web/` | The app the prototype shows (TypeScript, React, Vite, TanStack Query) |

## Commands

- `just dev` applies the local D1 migrations, then runs the web app and the Worker in one Vite process on http://localhost:5173 (`/api/*` is the Worker). No Docker, no Cloudflare account needed.
- `just test` runs Rust, Worker (workerd via Miniflare) and web tests.
- `just lint` runs rustfmt, clippy (warnings are errors), and tsc plus eslint for `worker/` and `web/`. Run both before opening a PR.
- `just migrate` applies `worker/migrations` to the local D1 database (`worker/.wrangler/state`; delete that folder to reset).

## Conventions

- Rust (`crates/core`): no `unwrap` or `expect` outside tests (clippy denies them), no I/O.
- Worker: routes are `createRoute` + `app.openapi` with zod schemas so the OpenAPI document stays true; errors are thrown as the one `AppError` (`worker/src/error.ts`) and become `{"error": {"code", "message"}}`; 5xx details are logged, never returned; log through `src/log.ts` only (eslint bans `console`); every handler has a test that calls `exports.default.fetch` in `worker/test/`. Bindings are declared in `wrangler.toml` and `src/env.ts`.
- Web: function components, server state only through TanStack Query, no global store, colours only from the design tokens, every page works at 390 px.
- GitHub and Claude are never called in tests. Tests use recorded responses and a fake `claude` binary.
- A fixture repository (`fixtures/shop`) with the prototype's checkout flow is the test subject for specs, reviews and coverage.
- One migration per task that changes the schema, as the next numbered file in `worker/migrations/` (D1 is SQLite: TEXT timestamps, no UUID type). Never edit a merged migration.
- Wording in the UI follows the prototype, word for word, unless the task says otherwise.
- One task per PR, titled "<task id> <task name>", with the "Done when" check and its output in the body.
