#!/usr/bin/env bash
set -euo pipefail

MENGSHU_RUN_LIVE_TESTS=1 \
npx vitest run tests/live/postgres-v9-runtime.e2e.test.ts

MENGSHU_RUN_LIVE_TESTS=1 \
npx vitest run tests/live/production-rest-runtime-eval.e2e.test.ts
