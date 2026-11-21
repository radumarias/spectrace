set shell := ["bash", "-eo", "pipefail", "-c"]

# list recipes
default:
    @just --list

# run the server (:8080) and the web app (:5173) together
dev:
    trap 'kill 0' EXIT; cargo run -p spectrace-server & npm --prefix web install --no-audit --no-fund && npm --prefix web run dev; wait

# run all tests (Rust and web)
test:
    cargo test --workspace
    npm --prefix web install --no-audit --no-fund
    npm --prefix web test

# format check, clippy and type check
lint:
    cargo fmt --all -- --check
    cargo clippy --workspace --all-targets -- -D warnings
    npm --prefix web install --no-audit --no-fund
    npm --prefix web run lint
