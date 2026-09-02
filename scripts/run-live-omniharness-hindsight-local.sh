#!/usr/bin/env bash
set -euo pipefail

: "${DLFM_TEST_DATABASE_URL:?DLFM_TEST_DATABASE_URL is required}"
: "${OMNIHARNESS_DIR:?OMNIHARNESS_DIR is required}"
: "${OMNIHARNESS_HINDSIGHT_DATABASE_URL:?OMNIHARNESS_HINDSIGHT_DATABASE_URL is required and must identify an isolated test database}"

EXPECTED_VERSION="${OMNIHARNESS_HINDSIGHT_EXPECTED_VERSION:-0.9.2}"
EXPECTED_OMNIHARNESS_COMMIT="${OMNIHARNESS_EXPECTED_COMMIT:-c1ed422adabc731a75270d9f572db9eed63b34ec}"
LIVE_E2E_SCRIPT="${DLFM_LIVE_E2E_SCRIPT:-scripts/live-omniharness-hindsight-e2e.mjs}"
PORT="${OMNIHARNESS_HINDSIGHT_PORT:-$((20000 + RANDOM % 20000))}"
VENV_DIR="${OMNIHARNESS_HINDSIGHT_VENV:-.tmp/hindsight-api-${EXPECTED_VERSION}-venv}"
HF_CACHE="${OMNIHARNESS_HINDSIGHT_HF_HOME:-.tmp/hindsight-hf-cache}"
HINDSIGHT_LOG="${TMPDIR:-/tmp}/dlfm-hindsight-e2e-$$.log"
HINDSIGHT_PID=""

cleanup() {
  if [[ -n "$HINDSIGHT_PID" ]] && kill -0 "$HINDSIGHT_PID" 2>/dev/null; then
    kill "$HINDSIGHT_PID" 2>/dev/null || true
    wait "$HINDSIGHT_PID" 2>/dev/null || true
  fi
  rm -f "$HINDSIGHT_LOG"
}
trap cleanup EXIT INT TERM

command -v python3 >/dev/null 2>&1 || {
  echo "Python 3.11+ is required for hindsight-api==${EXPECTED_VERSION}." >&2
  exit 1
}

ACTUAL_OMNIHARNESS_COMMIT="$(git -C "$OMNIHARNESS_DIR" rev-parse HEAD)"
if [[ "$ACTUAL_OMNIHARNESS_COMMIT" != "$EXPECTED_OMNIHARNESS_COMMIT" ]]; then
  echo "OmniHarness commit mismatch: expected ${EXPECTED_OMNIHARNESS_COMMIT}, got ${ACTUAL_OMNIHARNESS_COMMIT}" >&2
  exit 1
fi
if [[ -n "$(git -C "$OMNIHARNESS_DIR" status --porcelain --untracked-files=no)" ]]; then
  echo "OmniHarness tracked worktree must be clean for the live contract gate." >&2
  exit 1
fi

if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  python3 -m venv "$VENV_DIR"
fi

VENV_PYTHON="$VENV_DIR/bin/python"
INSTALLED_VERSION="$($VENV_PYTHON - <<'PY'
from importlib.metadata import PackageNotFoundError, version
try:
    print(version("hindsight-api"))
except PackageNotFoundError:
    print("")
PY
)"
if [[ "$INSTALLED_VERSION" != "$EXPECTED_VERSION" ]]; then
  "$VENV_PYTHON" -m pip install "hindsight-api==${EXPECTED_VERSION}"
fi

INSTALLED_VERSION="$($VENV_PYTHON - <<'PY'
from importlib.metadata import version
print(version("hindsight-api"))
PY
)"
if [[ "$INSTALLED_VERSION" != "$EXPECTED_VERSION" ]]; then
  echo "Hindsight version mismatch: expected ${EXPECTED_VERSION}, got ${INSTALLED_VERSION}" >&2
  exit 1
fi

npm run build
npm --prefix "$OMNIHARNESS_DIR" run build
mkdir -p "$HF_CACHE"

HF_HOME="$HF_CACHE" \
HINDSIGHT_API_DATABASE_URL="$OMNIHARNESS_HINDSIGHT_DATABASE_URL" \
HINDSIGHT_API_LLM_PROVIDER=none \
HINDSIGHT_API_WORKER_ID=dlfm-005a-local-e2e \
"$VENV_DIR/bin/hindsight-api" --host 127.0.0.1 --port "$PORT" >"$HINDSIGHT_LOG" 2>&1 &
HINDSIGHT_PID="$!"

for attempt in $(seq 1 90); do
  if node -e "fetch('http://127.0.0.1:${PORT}/health').then(r=>{if(!r.ok)process.exit(1);return r.json()}).then(x=>{if(x.status!=='healthy')process.exit(1)})" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$HINDSIGHT_PID" 2>/dev/null; then
    echo "Hindsight exited before becoming ready." >&2
    tail -n 200 "$HINDSIGHT_LOG" >&2 || true
    exit 1
  fi
  if [[ "$attempt" == "90" ]]; then
    echo "Hindsight did not become ready." >&2
    tail -n 200 "$HINDSIGHT_LOG" >&2 || true
    exit 1
  fi
  sleep 2
done

OMNIHARNESS_HINDSIGHT_URL="http://127.0.0.1:${PORT}" \
node "$LIVE_E2E_SCRIPT"
