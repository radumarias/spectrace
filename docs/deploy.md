# Deploying to Cloudflare

`just deploy` publishes the Worker (API), its D1 database and the web app (served as static assets from the same Worker) to your Cloudflare account. It is repeatable: re-running creates nothing twice, applies only new migrations, and redeploys the code.

## One-time setup

1. Pick the account that should host it and copy its **Account ID** (dashboard, Workers & Pages, right sidebar).
2. Create an **API token** (My Profile, API Tokens, Create Token, Custom token) with these permissions on that account:
   - Workers Scripts: Edit
   - D1: Edit
   - Account Settings: Read (lets wrangler find the account)
3. Export both (never commit them):

   ```sh
   export CLOUDFLARE_API_TOKEN=...
   export CLOUDFLARE_ACCOUNT_ID=...
   ```

Needs Node 22+ and [`just`](https://github.com/casey/just). No Rust is needed for this step.

## Deploy

```sh
just deploy
```

The script (`scripts/deploy.sh`):

1. creates the D1 database `spectrace` if it does not exist (override the name with `SPECTRACE_D1_NAME`);
2. applies `worker/migrations/*.sql` to the remote database;
3. builds the web app and Worker (`vite build`), writes the real database id into the built config, and runs `wrangler deploy`.

The Worker is published as `spectrace` at `https://spectrace.<your-subdomain>.workers.dev`; wrangler prints the URL at the end. Check it with `curl https://<url>/api/health`.

## devpage server

Specs are rendered by devpage server from Radu's fork ([radumarias/devpage](https://github.com/radumarias/devpage)), run as a [Cloudflare Container](https://developers.cloudflare.com/containers/) beside the Worker. The image is `containers/devpage/Dockerfile`: the fork's own `deploy/server` image, built from the fork at a pinned commit (`DEVPAGE_REV`). `wrangler deploy` builds and pushes it, so the machine that runs `just deploy` needs Docker. Containers need the Workers Paid plan.

Each index publishes every spec that changed as a devpage document (`POST /api/documents?entry=<flow>.md`); the Spec page's Markdown tab shows it at `/d/<id>/`, which the Worker proxies for the project's owner only.

devpage keeps every version and its SQLite store (through Litestream) in a bucket, so the container's disk is only a cache. One-time setup with R2:

1. Create an R2 bucket, for example `spectrace-devpage`.
2. Create an R2 API token with Object Read & Write on that bucket; note its Access Key ID and Secret Access Key.
3. Set the Worker's variables and secrets:

   ```sh
   cd worker
   npx wrangler secret put AWS_ACCESS_KEY_ID
   npx wrangler secret put AWS_SECRET_ACCESS_KEY
   npx wrangler secret put AWS_ENDPOINT_URL      # https://<account id>.r2.cloudflarestorage.com
   npx wrangler secret put DEVPAGE_BUCKET_URL    # s3://spectrace-devpage/docs
   ```

Until `DEVPAGE_BUCKET_URL` is set, devpage is off: nothing is published and the Markdown tab shows spectrace's own rendering. Locally, `just dev` never builds the image; to try devpage, run `devpage server` (with `DEVPAGE_BUCKET_URL=file:///some/folder DEVPAGE_DATA_DIR=/some/data DEVPAGE_USER_HEADER=x-spectrace-user`) and put `DEVPAGE_ORIGIN=http://127.0.0.1:3030` in `worker/.dev.vars`.

## Claude through AI Gateway

Agents and reviews call Claude through [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) (`worker/src/ai.ts`). Models: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`.

This path needs a standard Anthropic API key (console.anthropic.com), billed per token. A subscription token cannot be used here: the Messages API takes only API keys. To run on your Claude subscription instead, see [Claude Code on your subscription](#claude-code-on-your-subscription) below; this path stays the fallback.

```sh
cd worker
npx wrangler secret put ANTHROPIC_API_KEY        # sk-ant-..., never commit or paste it in chat
npx wrangler secret put AI_GATEWAY_ACCOUNT_ID    # your Cloudflare account id
npx wrangler secret put AI_GATEWAY_ID            # optional, default "default"
npx wrangler secret put CF_AIG_TOKEN             # only if the gateway has Authentication on: a token with "AI Gateway: Run"
```

If you store the Anthropic key in the gateway itself (BYOK), skip `ANTHROPIC_API_KEY` and set only `CF_AIG_TOKEN`. Check it signed in with `GET /api/ai/health`: it sends one 16-token Haiku message and answers 503 until configured.

## Claude Code on your subscription

Agent work can run on the owner's own Claude subscription (Pro, Max, Ultra, Team or Enterprise) instead of API tokens. The Worker hands each task to the **Claude Code CLI itself**, run headless (`claude -p`) in a Cloudflare Container beside it (`ClaudeCodeRunner`, image `containers/claude-code/Dockerfile`, code in `worker/src/claude-code.ts`). The image installs `@anthropic-ai/claude-code` at a pinned version exactly as published; spectrace never patches it.

Why this is allowed, and its limits ([Anthropic's legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance), checked 2026-11-22):

- Signing in to the unmodified Claude Code binary with your own subscription is allowed, including where it is hosted for you; `claude setup-token` exists for exactly this kind of headless use.
- Routing other people's requests through your plan is not. So only the GitHub login in `CLAUDE_CODE_OWNER` gets the subscription; every other user's work goes through the API key path above (or fails with 503 if there is none). Do not share the token or set it on a deployment other people use as their own.
- Plan usage limits assume ordinary individual use. Heavy agent runs count against your limits like any Claude Code session.

One-time setup:

1. On your own machine, signed in to the subscription you want to use: `claude setup-token`. Approve in the browser; it prints a token that is valid for one year. Copy it straight into the next command and never paste it in chat or commit it.
2. Set the secret and your login:

   ```sh
   cd worker
   npx wrangler secret put CLAUDE_CODE_OAUTH_TOKEN   # the token from step 1
   npx wrangler secret put CLAUDE_CODE_OWNER         # your GitHub login, e.g. radumarias
   ```

3. `just deploy` (needs Docker, like devpage: wrangler builds and pushes the image; Containers need the Workers Paid plan).
4. Signed in as that login, open `GET /api/ai/health`. It answers `"backend": "claude-code"` when the message went through Claude Code on the subscription, `"backend": "api"` when it fell back to the API key.

Until `CLAUDE_CODE_OAUTH_TOKEN` is set, the container is never started and everything uses the API key. Renew the token before it expires (a year after step 1): rerun step 1 and `wrangler secret put` again. To try it locally, build and run the image (`docker build -t spectrace-claude-code containers/claude-code && docker run -p 8080:8080 -e CLAUDE_CODE_OAUTH_TOKEN spectrace-claude-code`) and put `CLAUDE_CODE_ORIGIN=http://127.0.0.1:8080` and `CLAUDE_CODE_OWNER=<your login>` in `worker/.dev.vars`.

## Each user's own API key

Other users bring their own Anthropic API key: on the **Runners** page they paste a key from console.anthropic.com, and their agent work is billed to their Anthropic account. Keys are stored in D1 encrypted with AES-GCM (`worker/src/user-keys.ts`), bound to the user's id, and are never returned by the API; the page shows only the last four characters. spectrace never asks for or stores a Claude subscription token (Anthropic's terms forbid apps collecting them), and the API refuses one.

One-time setup, a random 32-byte encryption key:

```sh
cd worker
openssl rand -base64 32 | npx wrangler secret put SECRETS_KEY
```

Keep it: losing or changing it makes every saved key unreadable, and users have to paste theirs again. Until it is set, the Runners page says the server can't save keys. Which Claude a user's work uses, in order: the owner's subscription (above), the user's own key, the server's `ANTHROPIC_API_KEY`.

## Cost

Workers, D1 and static assets are all within the free plan for this app at its current size. The devpage and Claude Code containers need the Workers Paid plan; they sleep after 30 and 10 minutes without requests, and R2 storage for spec versions is small.

## Not yet deployed

Sign-in (T0.8), Durable Objects, Queues and the AI Gateway arrive with later tasks and add their own secrets and bindings to this guide.
