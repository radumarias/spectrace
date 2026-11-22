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

**Use a standard Anthropic API key (console.anthropic.com), billed per token.** A Claude Pro/Max subscription token (`claude setup-token`) is not supported: Anthropic's terms only allow it inside Claude Code and Claude.ai, not in a server-side app or the Messages API.

```sh
cd worker
npx wrangler secret put ANTHROPIC_API_KEY        # sk-ant-..., never commit or paste it in chat
npx wrangler secret put AI_GATEWAY_ACCOUNT_ID    # your Cloudflare account id
npx wrangler secret put AI_GATEWAY_ID            # optional, default "default"
npx wrangler secret put CF_AIG_TOKEN             # only if the gateway has Authentication on: a token with "AI Gateway: Run"
```

If you store the Anthropic key in the gateway itself (BYOK), skip `ANTHROPIC_API_KEY` and set only `CF_AIG_TOKEN`. Check it signed in with `GET /api/ai/health`: it sends one 16-token Haiku message and answers 503 until configured.

## Cost

Workers, D1 and static assets are all within the free plan for this app at its current size. The devpage container needs the Workers Paid plan; it sleeps after 30 minutes without requests, and R2 storage for spec versions is small.

## Not yet deployed

Sign-in (T0.8), Durable Objects, Queues and the AI Gateway arrive with later tasks and add their own secrets and bindings to this guide.
