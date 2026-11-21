#!/usr/bin/env bash
# Deploy spectrace (Worker + D1 + web app) to Cloudflare. Repeatable: safe to run again.
# Needs CLOUDFLARE_API_TOKEN (Workers Scripts:Edit, D1:Edit) and CLOUDFLARE_ACCOUNT_ID.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN (see docs/deploy.md)}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID (see docs/deploy.md)}"
DB_NAME="${SPECTRACE_D1_NAME:-spectrace}"
WRANGLER=(npm --prefix worker exec -- wrangler)

npm --prefix worker install --no-audit --no-fund
npm --prefix web install --no-audit --no-fund

# 1. D1 database: reuse it if it exists, create it otherwise.
db_id() {
  "${WRANGLER[@]}" d1 list --json 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).find(d=>d.name===process.argv[1]);if(r)console.log(r.uuid)})' "$DB_NAME"
}
DB_ID="$(db_id)"
if [ -z "$DB_ID" ]; then
  echo "Creating D1 database $DB_NAME"
  "${WRANGLER[@]}" d1 create "$DB_NAME" >/dev/null
  DB_ID="$(db_id)"
fi
echo "D1 database $DB_NAME = $DB_ID"

# 2. Apply migrations to the remote database (a temporary config carries the real id).
sed "s/^database_id = .*/database_id = \"$DB_ID\"/" worker/wrangler.toml > worker/wrangler.deploy.toml
trap 'rm -f worker/wrangler.deploy.toml' EXIT
"${WRANGLER[@]}" d1 migrations apply DB --remote --config worker/wrangler.deploy.toml

# 3. Build the web app and Worker, put the real database id into the built config, deploy.
npm --prefix web run build
OUT="$(node -e 'const c=require("./web/.wrangler/deploy/config.json");console.log(c.configPath)' 2>/dev/null || true)"
[ -n "$OUT" ] || { echo "build did not write web/.wrangler/deploy/config.json" >&2; exit 1; }
CFG="$(cd web/.wrangler/deploy && realpath "$OUT")"
node -e '
const fs=require("fs");const [f,id]=process.argv.slice(1);
const c=JSON.parse(fs.readFileSync(f,"utf8"));
for(const d of c.d1_databases??[])d.database_id=id;
fs.writeFileSync(f,JSON.stringify(c,null,2));' "$CFG" "$DB_ID"
(cd web && npm --prefix ../worker exec -- wrangler deploy --config "$CFG")
