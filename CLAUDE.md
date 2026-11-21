# spectrace

Spec-driven PR review and agent orchestration. One Rust server owns the data and talks to GitHub. Runners are separate processes that pull jobs from it and run agents. The web app only talks to the server.

Plan: https://claude.ai/artifact/Ko3v3QgPX2n2PhGZFt8Gnh
UI reference prototype: https://claude.ai/artifact/E53sDphecfigvdt7Kk82Mx

## Layout

| Path | What it is |
|---|---|
| `crates/server` | REST API, GitHub webhooks, job queue, live events (Rust, axum, sqlx, Postgres, SSE) |
| `crates/runner` | Claims a job, checks out the repo in a worktree, runs an agent, streams logs back |
| `crates/core` | Spec parsing, spec index, file-to-spec mapping, gate rules. No I/O |
| `web/` | The app the prototype shows (TypeScript, React, Vite, TanStack Query) |

## Commands

- `just dev` runs the server on :8080 and the web app on :5173 (proxies `/api`).
- `just test` runs Rust and web tests.
- `just lint` runs rustfmt, clippy (warnings are errors) and the TypeScript check. Run both before opening a PR.

## Conventions

- Rust: no `unwrap` or `expect` outside tests (clippy denies them), errors through one `AppError` type with `thiserror`, sqlx queries checked at compile time, every handler has an integration test.
- Web: function components, server state only through TanStack Query, no global store, colours only from the design tokens, every page works at 390 px.
- GitHub and Claude are never called in tests. Tests use recorded responses and a fake `claude` binary.
- A fixture repository (`fixtures/shop`) with the prototype's checkout flow is the test subject for specs, reviews and coverage.
- One migration per task that changes the schema. Never edit a merged migration.
- Wording in the UI follows the prototype, word for word, unless the task says otherwise.
- One task per PR, titled "<task id> <task name>", with the "Done when" check and its output in the body.
