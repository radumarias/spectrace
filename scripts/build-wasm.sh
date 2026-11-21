#!/usr/bin/env bash
# Builds crates/core-wasm and writes the wasm-bindgen output to worker/src/wasm/
# (git-ignored). Needs the wasm32 target and wasm-bindgen-cli at the version
# pinned in crates/core-wasm/Cargo.toml; both are installed here when missing.
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(sed -n 's/^wasm-bindgen = "=\(.*\)"/\1/p' crates/core-wasm/Cargo.toml)
[ -n "$version" ] || { echo "cannot read the wasm-bindgen version" >&2; exit 1; }

if ! rustup target list --installed | grep -qx wasm32-unknown-unknown; then
  rustup target add wasm32-unknown-unknown
fi
if [ "$(wasm-bindgen --version 2>/dev/null | cut -d' ' -f2)" != "$version" ]; then
  cargo install wasm-bindgen-cli --version "$version" --locked
fi

cargo build -p spectrace-core-wasm --target wasm32-unknown-unknown --release
rm -rf worker/src/wasm
wasm-bindgen --target web --out-dir worker/src/wasm --out-name spectrace_core \
  target/wasm32-unknown-unknown/release/spectrace_core_wasm.wasm
