set shell := ["bash", "-eo", "pipefail", "-c"]

# list recipes
default:
    @just --list

# install JS dependencies for the web app and the Worker
install:
    npm --prefix web install --no-audit --no-fund
    npm --prefix worker install --no-audit --no-fund

# build crates/core to WASM into worker/src/wasm (installs the wasm32 target and wasm-bindgen-cli if missing)
wasm:
    scripts/build-wasm.sh

# create or update the local D1 database (stored in worker/.wrangler/state)
migrate: install
    npm --prefix worker run migrate:local

# web app and API on one port: http://localhost:5173 (API under /api)
dev: wasm migrate
    npm --prefix web run dev

# run all tests (Rust, Worker, web)
test: install wasm
    cargo test --workspace
    npm --prefix worker test
    npm --prefix web test

# end-to-end tests (Playwright, 1440 and 390 px) against `vite dev` with the Worker and a local D1; see web/e2e
# first time on a machine: npm --prefix web exec -- playwright install chromium
e2e: install wasm migrate
    npm --prefix web run e2e

# format check, clippy, and type check plus eslint for the Worker and the web app
lint: install wasm
    cargo fmt --all -- --check
    cargo clippy --workspace --all-targets -- -D warnings
    npm --prefix worker run lint
    npm --prefix worker run -s openapi -- --check
    npm --prefix web run lint

# regenerate web/openapi.json and the typed client (web/src/api/schema.d.ts) from the Worker's routes; run after changing a route
api-client: install
    npm --prefix worker run -s openapi > web/openapi.json
    npm --prefix web run api-client

# deploy the Worker, D1 migrations and web app to Cloudflare (see docs/deploy.md)
deploy: wasm
    scripts/deploy.sh
