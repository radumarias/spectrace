# spectrace

Spec-driven PR review and agent orchestration. See the implementation plan: https://claude.ai/artifact/Ko3v3QgPX2n2PhGZFt8Gnh

## Run it locally

Needs Node 22+, Rust (for `crates/core`) and [`just`](https://github.com/casey/just). No Docker and no Cloudflare account.

```sh
just dev                              # web app and API on http://localhost:5173
curl localhost:5173/api/health        # {"status":"ok","service":"spectrace-worker","database":"ok"}
curl localhost:5173/api/openapi.json  # the API description
```

`just dev` installs dependencies, applies `worker/migrations` to a local D1 database, and starts Vite with the Cloudflare plugin, which runs the Worker from `worker/` in the same process (workerd). The web app and `/api` share one origin, so there is no proxy and no CORS.

```sh
just test     # Rust, Worker and web tests
just lint     # rustfmt, clippy, tsc and eslint
just migrate  # apply new D1 migrations to the local database
```

Worker settings are bindings and variables in `worker/wrangler.toml`. Secrets for local work go in `worker/.dev.vars` (git-ignored); copy `worker/.dev.vars.example`.

## Sign in with GitHub

Create an OAuth app at https://github.com/settings/developers with callback URL `http://localhost:5173/api/auth/github/callback`, put its id and secret in `worker/.dev.vars` (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `PUBLIC_URL`), run `just dev`, and open http://localhost:5173/api/auth/github/login. On Cloudflare, set the same with `wrangler secret put GITHUB_CLIENT_ID`, `wrangler secret put GITHUB_CLIENT_SECRET` and `PUBLIC_URL` (secret or var) set to the deployed origin, with the OAuth app's callback URL changed to match.
