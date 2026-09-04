#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVICE_NAME="dlmf-pilot-postgres.service"
LIBEXEC_DIR="$HOME/.local/libexec/dlmf-production-pilot"
USER_UNIT_DIR="$HOME/.config/systemd/user"
UNIT_PATH="$USER_UNIT_DIR/$SERVICE_NAME"
ENV_FILE="${DLMF_PILOT_ENV_FILE:-$HOME/.config/dlmf/production-pilot.env}"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "DLMF_PILOT_PG0_SERVICE=FAIL" >&2
  echo "systemctl is not available; cannot install managed pg0 service." >&2
  exit 1
fi

if ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "DLMF_PILOT_PG0_SERVICE=FAIL" >&2
  echo "The systemd user manager is unavailable for this login session." >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "DLMF_PILOT_PG0_SERVICE=FAIL" >&2
  echo "Pilot PostgreSQL config does not exist: $ENV_FILE" >&2
  exit 1
fi

mkdir -p "$LIBEXEC_DIR" "$USER_UNIT_DIR"
chmod 700 "$HOME/.local/libexec" 2>/dev/null || true
chmod 700 "$LIBEXEC_DIR"

install -m 0700 "$ROOT/scripts/production-pilot/serve-dlmf-pg0.py" "$LIBEXEC_DIR/serve-dlmf-pg0.py"
install -m 0700 "$ROOT/scripts/production-pilot/run-dlmf-pg0-service.sh" "$LIBEXEC_DIR/run-dlmf-pg0-service.sh"

cat > "$UNIT_PATH" <<'EOF'
[Unit]
Description=DLMF Pilot PostgreSQL (pg0)
Documentation=https://github.com/vectorize-io/pg0
After=default.target

[Service]
Type=simple
ExecStart=/bin/bash %h/.local/libexec/dlmf-production-pilot/run-dlmf-pg0-service.sh
Restart=on-failure
RestartSec=3s
TimeoutStartSec=90s
TimeoutStopSec=60s
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
EOF
chmod 0644 "$UNIT_PATH"

systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME" >/dev/null
# Restart intentionally hands lifecycle ownership to the freshly installed monitor.
# pg0 >=0.14.2 waits for complete shutdown, avoiding stop/start races.
systemctl --user restart "$SERVICE_NAME"

active="unknown"
for _ in $(seq 1 30); do
  active="$(systemctl --user is-active "$SERVICE_NAME" 2>/dev/null || true)"
  if [[ "$active" == "active" ]]; then
    break
  fi
  sleep 0.5
done

enabled="$(systemctl --user is-enabled "$SERVICE_NAME" 2>/dev/null || true)"
if [[ "$active" != "active" ]]; then
  echo "DLMF Pilot PostgreSQL managed service" >&2
  echo "unit=$UNIT_PATH" >&2
  echo "active=$active enabled=$enabled" >&2
  echo "DLMF_PILOT_PG0_SERVICE=FAIL" >&2
  systemctl --user --no-pager --full status "$SERVICE_NAME" >&2 || true
  exit 1
fi

echo "DLMF Pilot PostgreSQL managed service"
echo "unit=$UNIT_PATH"
echo "active=$active enabled=$enabled restart=on-failure"
echo "DLMF_PILOT_PG0_SERVICE=PASS"
