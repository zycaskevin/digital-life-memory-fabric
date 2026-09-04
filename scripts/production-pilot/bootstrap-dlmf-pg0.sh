#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PY_SCRIPT="$ROOT/scripts/production-pilot/bootstrap-dlmf-pg0.py"
SERVICE_INSTALLER="$ROOT/scripts/production-pilot/install-dlmf-pg0-systemd.sh"

run_bootstrap() {
  if command -v uv >/dev/null 2>&1; then
    uv run --quiet --with 'pg0-embedded>=0.15.0,<1' python "$PY_SCRIPT"
    return
  fi

  if command -v python3 >/dev/null 2>&1 && python3 -c 'import pg0' >/dev/null 2>&1; then
    python3 "$PY_SCRIPT"
    return
  fi

  cat >&2 <<'EOF'
DLMF_PILOT_PG0_BOOTSTRAP=FAIL
Neither `uv` nor a Python environment with `pg0` is available.
Hermes installations normally include `uv`; ensure it is on PATH and rerun.
EOF
  return 1
}

run_bootstrap

# On Linux/systemd hosts, hand lifecycle ownership to a user service so pg0
# survives terminal exits, login-session churn, and process crashes. Set
# DLMF_PILOT_MANAGED_SERVICE=0 only for non-systemd development environments.
if [[ "${DLMF_PILOT_MANAGED_SERVICE:-1}" != "0" ]]; then
  if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    bash "$SERVICE_INSTALLER"
  else
    echo "DLMF_PILOT_PG0_SERVICE=UNAVAILABLE"
    echo "systemd user manager not available; PostgreSQL was started but is not lifecycle-managed."
  fi
fi
