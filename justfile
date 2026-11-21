set shell := ["bash", "-eo", "pipefail", "-c"]
set dotenv-load

export DATABASE_URL := env_var_or_default("DATABASE_URL", "postgres://spectrace:spectrace@localhost:5432/spectrace")

# list recipes
default:
    @just --list

# start Postgres (Docker Compose) and wait until it is healthy
db:
    docker compose up -d --wait postgres

# stop Postgres (data is kept; `docker compose down -v` wipes it)
db-stop:
    docker compose stop postgres

# run the server (:8080) and the web app (:5173) together
dev: db
    trap 'kill 0' EXIT; cargo run -p spectrace-server & npm --prefix web install --no-audit --no-fund && npm --prefix web run dev; wait

# run all tests (Rust and web); the server tests need Postgres
test: db
    cargo test --workspace
    npm --prefix web install --no-audit --no-fund
    npm --prefix web test

# format check, clippy and type check
lint:
    cargo fmt --all -- --check
    cargo clippy --workspace --all-targets -- -D warnings
    npm --prefix web install --no-audit --no-fund
    npm --prefix web run lint

# regenerate web/openapi.json and the typed client (web/src/api/schema.d.ts); run after changing a handler's annotations
api-client:
    cargo run -q -p spectrace-server --example openapi > web/openapi.json
    npm --prefix web install --no-audit --no-fund
    npm --prefix web run api-client
