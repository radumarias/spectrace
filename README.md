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

## GitHub App (repo list)

Create a GitHub App at https://github.com/settings/apps/new:

- Callback URL `http://localhost:5173/api/auth/github/callback`; tick **Request user authorization (OAuth) during installation**.
- Setup URL `http://localhost:5173/api/github/install/callback`; tick **Redirect on update**.
- Repository permissions: Contents read, Pull requests read and write, Checks read, Metadata read. Subscribe to the events Pull request, Pull request review, Check suite and Push.
- Webhook: tick **Active**, set the URL to `<PUBLIC_URL>/api/github/webhook` and a **Webhook secret** (a long random string). GitHub cannot reach `localhost`; to try it locally, tunnel port 5173 and use that URL.
- After creating it, generate a **private key** (downloads a `.pem`) and note the **App ID** and the URL **slug**.

Use the App's own **Client ID** and a generated **client secret** as `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, so sign-in and install share one app. Then add to `worker/.dev.vars`: `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY` (the PEM, with `\n` for line breaks if on one line) and `GITHUB_WEBHOOK_SECRET` (the webhook secret). Sign in, open http://localhost:5173/api/github/install, install it on your account, and `GET /api/github/repos` lists the repositories. On Cloudflare set the same four with `wrangler secret put`, and change the App's two URLs to the deployed origin.

## Deploy

`just deploy` publishes to Cloudflare. Setup and what it does: [docs/deploy.md](docs/deploy.md).
