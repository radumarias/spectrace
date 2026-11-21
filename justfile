set shell := ["bash", "-eo", "pipefail", "-c"]

# list recipes
default:
    @just --list

# install JS dependencies for the web app and the Worker
install:
    npm --prefix web install --no-audit --no-fund
    npm --prefix worker install --no-audit --no-fund

# create or update the local D1 database (stored in worker/.wrangler/state)
migrate: install
    npm --prefix worker run migrate:local

# web app and API on one port: http://localhost:5173 (API under /api)
dev: migrate
    npm --prefix web run dev

# run all tests (Rust, Worker, web)
test: install
    cargo test --workspace
    npm --prefix worker test
    npm --prefix web test

# format check, clippy, and type check plus eslint for the Worker and the web app
lint: install
    cargo fmt --all -- --check
    cargo clippy --workspace --all-targets -- -D warnings
    npm --prefix worker run lint
    npm --prefix web run lint
