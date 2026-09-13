#!/usr/bin/env bash
set -euo pipefail

dlmf_ci_container="dlmf-ci-local-green-${BASHPID}"
dlmf_ci_started=0

cleanup() {
  if [[ "$dlmf_ci_started" -eq 1 ]]; then
    docker stop "$dlmf_ci_container" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

docker run --rm -d \
  --name "$dlmf_ci_container" \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  -p 127.0.0.1::5432 \
  postgres:16 >/dev/null
dlmf_ci_started=1

for dlmf_ci_attempt in $(seq 1 30); do
  if docker exec "$dlmf_ci_container" pg_isready -U postgres -d postgres -q; then
    break
  fi
  sleep 1
done

if ! docker exec "$dlmf_ci_container" pg_isready -U postgres -d postgres -q; then
  echo "Disposable PostgreSQL did not become ready" >&2
  exit 1
fi

dlmf_ci_port="$(docker port "$dlmf_ci_container" 5432/tcp | sed -n 's/.*://p')"
DLFM_TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:${dlmf_ci_port}/postgres" npm run check
