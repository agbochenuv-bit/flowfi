#!/usr/bin/env bash
set -euo pipefail

project="flowfi-runtime-$$"
frontend="${project}-frontend"
export COMPOSE_PROJECT_NAME="$project"

cleanup() {
  docker compose logs backend || true
  docker logs "$frontend" || true
  docker rm -f "$frontend" >/dev/null 2>&1 || true
  docker compose down --volumes
}
trap cleanup EXIT

docker compose build backend
docker build --file frontend/Dockerfile --tag "$frontend" .
docker compose up -d --wait postgres
DATABASE_URL=postgresql://flowfi:flowfi_dev_password@127.0.0.1:5433/flowfi \
  npm exec --workspace=backend -- prisma db push --schema=prisma/schema.prisma

docker compose create backend
backend_image=$(docker compose images -q backend)
if docker run --rm -e NODE_ENV=development "$backend_image"; then
  echo 'Backend unexpectedly booted without DATABASE_URL' >&2
  exit 1
fi

docker compose up -d --wait --wait-timeout 90 backend
backend=$(docker compose ps -q backend)
docker run -d --name "$frontend" "$frontend"

for container in "$backend" "$frontend"; do
  docker exec "$container" node -e 'if (process.getuid() === 0) process.exit(1)'
  for ((attempt=0; attempt<60; attempt++)); do
    if [[ $(docker inspect -f '{{.State.Health.Status}}' "$container") == healthy ]]; then
      break
    fi
    sleep 1
  done
  [[ $(docker inspect -f '{{.State.Health.Status}}' "$container") == healthy ]]
  docker stop --timeout 65 "$container" >/dev/null
  [[ $(docker inspect -f '{{.State.ExitCode}}' "$container") == 0 ]]
done

docker logs "$backend" 2>&1 | grep -F 'Received SIGTERM. Shutting down gracefully'
