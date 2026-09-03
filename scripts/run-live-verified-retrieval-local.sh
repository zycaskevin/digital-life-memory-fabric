#!/usr/bin/env bash
set -euo pipefail

DLFM_LIVE_E2E_SCRIPT=scripts/live-verified-retrieval-e2e.mjs \
  exec bash scripts/run-live-omniharness-hindsight-local.sh
