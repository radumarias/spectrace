# spectrace

Spec-driven PR review and agent orchestration. See the implementation plan: https://claude.ai/artifact/Ko3v3QgPX2n2PhGZFt8Gnh

## Run the server

Needs Docker (for Postgres) and [`just`](https://github.com/casey/just).

```sh
just db      # Postgres 16 via Docker Compose, waits until healthy
just dev     # starts the database, then server (:8080) and web app (:5173)
curl localhost:8080/api/health
```

Settings come from environment variables (see `.env.example`; copy it to `.env`): `DATABASE_URL` (required), `BIND_ADDR` or `PORT`, `LOG_FORMAT` (`pretty` or `json`), `RUST_LOG`, and for GitHub sign-in `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `PUBLIC_URL`. Migrations in `crates/server/migrations` run on startup.

## GitHub App

To list and read your repositories the server uses a GitHub App (see `.env.example` for how to create it and which settings to tick). Set `GITHUB_APP_ID`, `GITHUB_APP_SLUG` and the private key, sign in, then open `/api/github/install` in the browser to install the app. `GET /api/github/repos` lists the repositories of the installations you made.
