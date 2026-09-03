#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PY_SCRIPT="$ROOT/scripts/production-pilot/bootstrap-dlmf-pg0.py"

if command -v uv >/dev/null 2>&1; then
  exec uv run --quiet --with 'pg0-embedded>=0.15.0,<1' python "$PY_SCRIPT"
fi

if command -v python3 >/dev/null 2>&1 && python3 -c 'import pg0' >/dev/null 2>&1; then
  exec python3 "$PY_SCRIPT"
fi

cat >&2 <<'EOF'
DLMF_PILOT_PG0_BOOTSTRAP=FAIL
Neither `uv` nor a Python environment with `pg0` is available.
Hermes installations normally include `uv`; ensure it is on PATH and rerun.
EOF
exit 1
