#!/usr/bin/env bash
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required for the explicit PostgreSQL v9 live test" >&2
  exit 1
fi

image="${MENGSHU_LIVE_PGVECTOR_IMAGE:-pgvector/pgvector:pg16}"
container="mengshu-live-v9-${RANDOM}-$$"
database="mengshu_live_v9"
user="mengshu_live"
password="mengshu_live_password"

cleanup() {
  docker rm -f "${container}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker run --detach --rm \
  --name "${container}" \
  --env "POSTGRES_DB=${database}" \
  --env "POSTGRES_USER=${user}" \
  --env "POSTGRES_PASSWORD=${password}" \
  --publish 127.0.0.1::5432 \
  "${image}" >/dev/null

ready_streak=0
for _ in $(seq 1 120); do
  if docker exec "${container}" pg_isready -U "${user}" -d "${database}" >/dev/null 2>&1; then
    ready_streak=$((ready_streak + 1))
    if [ "${ready_streak}" -ge 3 ]; then
      break
    fi
  else
    ready_streak=0
  fi
  sleep 0.25
done

if [ "${ready_streak}" -lt 3 ]; then
  echo "temporary pgvector container did not become ready" >&2
  exit 1
fi

port="$(docker inspect --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' "${container}")"

MENGSHU_RUN_LIVE_TESTS=1 \
MENGSHU_LIVE_PG_ALLOW_RESET=1 \
MENGSHU_LIVE_PG_HOST=127.0.0.1 \
MENGSHU_LIVE_PG_PORT="${port}" \
MENGSHU_LIVE_PG_DATABASE="${database}" \
MENGSHU_LIVE_PG_USER="${user}" \
MENGSHU_LIVE_PG_PASSWORD="${password}" \
npx vitest run tests/live/postgres-v9-runtime.e2e.test.ts

MENGSHU_RUN_LIVE_TESTS=1 \
MENGSHU_LIVE_PG_ALLOW_RESET=1 \
MENGSHU_LIVE_PG_HOST=127.0.0.1 \
MENGSHU_LIVE_PG_PORT="${port}" \
MENGSHU_LIVE_PG_DATABASE="${database}" \
MENGSHU_LIVE_PG_USER="${user}" \
MENGSHU_LIVE_PG_PASSWORD="${password}" \
npx vitest run tests/live/production-rest-runtime-eval.e2e.test.ts
