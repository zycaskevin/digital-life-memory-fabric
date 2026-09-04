#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
SERVICE_ROOT="$HOME/.local/libexec/dlmf-production-pilot"
PY_SCRIPT="$SERVICE_ROOT/serve-dlmf-pg0.py"

if [[ ! -f "$PY_SCRIPT" ]]; then
  echo "DLMF_PILOT_PG0_SERVICE=FAIL" >&2
  echo "Managed pg0 service script is missing: $PY_SCRIPT" >&2
  exit 1
fi

if command -v uv >/dev/null 2>&1; then
  exec uv run --quiet --with 'pg0-embedded>=0.15.0,<1' python "$PY_SCRIPT"
fi

if command -v python3 >/dev/null 2>&1 && python3 -c 'import pg0' >/dev/null 2>&1; then
  exec python3 "$PY_SCRIPT"
fi

echo "DLMF_PILOT_PG0_SERVICE=FAIL" >&2
echo "Neither uv nor a Python environment with pg0 is available to the systemd user service." >&2
exit 1
