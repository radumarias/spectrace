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

## Cost

Workers, D1 and static assets are all within the free plan for this app at its current size. Nothing in `just deploy` enables a paid product.

## Not yet deployed

Sign-in (T0.8), Durable Objects, Queues and the AI Gateway arrive with later tasks and add their own secrets and bindings to this guide.
