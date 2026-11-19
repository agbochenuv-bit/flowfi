#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  '') testnet=false ;;
  --testnet-smoke) testnet=true ;;
  *) echo "Usage: bash scripts/verify-clean-clone.sh [--testnet-smoke]" >&2; exit 2 ;;
esac
if (( $# > 1 )); then
  echo "Expected at most one option" >&2
  exit 2
fi

cd "$(dirname "$0")/.."
shopt -s nullglob dotglob
for file in .env* backend/.env* frontend/.env*; do
  if [[ "$file" != *.example ]]; then
    echo "Use a clean checkout without environment files: $file" >&2
    exit 2
  fi
done

for tool in node npm docker cargo curl; do
  if ! command -v "$tool" >/dev/null; then
    echo "Missing required tool: $tool" >&2
    exit 2
  fi
done

# Give application commands only local settings, even if the shell is configured
# for a deployed environment. The opt-in smoke uses the suite's Testnet defaults.
jwt_secret=$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")
local_env=(env -i "PATH=$PATH" "HOME=$HOME" CI=1 HUSKY=0
  "JWT_SECRET=$jwt_secret" OTEL_SDK_DISABLED=true
  STELLAR_NETWORK=testnet SANDBOX_MODE_ENABLED=false
  NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_API_URL=http://localhost:3001/v1)

scratch=$(mktemp -d)
db=
backend=
frontend=
cleanup() {
  if [[ -n "$frontend" ]]; then kill "$frontend" 2>/dev/null || true; fi
  if [[ -n "$backend" ]]; then kill "$backend" 2>/dev/null || true; fi
  if [[ -n "$db" ]]; then docker rm -fv "$db" >/dev/null || true; fi
  rm -rf "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

wait_for() {
  local description=$1
  shift
  for ((attempt=0; attempt<60; attempt++)); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "Timed out waiting for $description" >&2
  return 1
}

# Match the pinned image in Compose. Publish only to loopback on a free port.
image=$(awk '/image: postgres:16-alpine@sha256:/ {print $2; exit}' docker-compose.yml)
db=$(docker run --detach --publish 127.0.0.1::5432 \
  -e POSTGRES_PASSWORD=flowfi_local_only -e POSTGRES_DB=flowfi_test "$image")
wait_for PostgreSQL docker exec "$db" pg_isready -h 127.0.0.1 -U postgres -d flowfi_test
address=$(docker port "$db" 5432/tcp)
local_env+=("DATABASE_URL=postgresql://postgres:flowfi_local_only@$address/flowfi_test")

"${local_env[@]}" npm ci --include=optional
(
  cd backend
  "${local_env[@]}" npx --no-install prisma generate
  "${local_env[@]}" npx --no-install prisma db push
  "${local_env[@]}" npm run build -- --rootDir .
  "${local_env[@]}" NODE_ENV=test npm test
)
(
  cd frontend
  "${local_env[@]}" npm run lint
  "${local_env[@]}" npm run test:coverage
  "${local_env[@]}" npm run build
  bash scripts/check-bundle-size.sh
)
(cd contracts && cargo test --locked)

for port in 3000 3001; do
  if (echo >/dev/tcp/127.0.0.1/"$port") 2>/dev/null; then
    echo "Local port $port must be free" >&2
    exit 2
  fi
done
# The local health endpoint probes RPC for diagnostics even with indexing off.
# Use a loopback endpoint so that boot never probes public Testnet.
(cd backend && exec "${local_env[@]}" PORT=3001 SOROBAN_RPC_URL=http://127.0.0.1:1 node dist/src/index.js) >"$scratch/backend.log" 2>&1 &
backend=$!
(cd frontend && exec "${local_env[@]}" node ../node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3000) >"$scratch/frontend.log" 2>&1 &
frontend=$!
if ! wait_for backend curl --fail --max-time 2 http://127.0.0.1:3001/health ||
   ! wait_for frontend curl --fail --max-time 2 http://127.0.0.1:3000/; then
  cat "$scratch/backend.log" "$scratch/frontend.log" >&2
  exit 1
fi

if "$testnet"; then
  (cd backend && "${local_env[@]}" npm run test:e2e:testnet -- network-health)
fi
