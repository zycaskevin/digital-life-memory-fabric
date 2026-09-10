# GB10 deployment candidate — DLMF Digital-Life-Stack ingress

**Status:** repository deployment template only; not activated by this implementation packet.

This bundle is the deployment shape for the sole formal upper-system DLMF integration target: Digital-Life-Stack. Relationship OS is not part of this path.

## Authority boundary

The service owns the DLMF composition and keeps the following invariants:

- DLMF PostgreSQL remains Canonical Memory truth.
- Digital-Life-Stack receives no direct canonical commit or promotion operation.
- Hindsight is instantiated inside DLMF as `MemoryDistillationProvider` plus a derived canonical projection.
- Provider results are never canonical truth; retrieval text is hydrated from DLMF canonical storage.
- The service binds loopback only.
- A stale, partial, future, or unavailable DLMF schema is not ready.

## Pre-deployment gate

From the reviewed DLMF checkout:

```bash
npm ci
npm run check
node --check scripts/digital-life-stack-ingress-server.mjs
```

Use a disposable PostgreSQL schema first and prove bootstrap/replay/readiness before touching a durable target.

## Protected host configuration

Prepare host paths only when deployment has been separately authorized:

```bash
sudo install -d -m 0750 /var/lib/dlmf/digital-life-stack
sudo install -d -m 0750 /var/lib/dlmf/digital-life-stack/archive
sudo install -d -m 0750 /etc/dlmf
sudo install -m 0640 deploy/gb10/digital-life-stack/ingress.env.example \
  /etc/dlmf/digital-life-stack.env
```

Replace all `REPLACE_WITH_*` values outside Git. Do not store database credentials, bearer tokens, or provider keys in this repository.

## Bootstrap and upgrade

Normal bootstrap:

```bash
set -a
. /etc/dlmf/digital-life-stack.env
set +a
node scripts/digital-life-stack-bootstrap.mjs
node scripts/digital-life-stack-health.mjs
```

A fresh schema receives migrations 0001–0007. A current schema is verification-only and replay-safe.

A stale 0005/0006 schema intentionally fails closed. Upgrade is a distinct deployment action:

```bash
DLMF_DLS_ALLOW_UPGRADE=1 node scripts/digital-life-stack-bootstrap.mjs
```

Do not persist `DLMF_DLS_ALLOW_UPGRADE=1` in the normal service environment. Before an upgrade, create a protected PostgreSQL backup and retain the exact reviewed code SHA plus migration evidence.

Partial/corrupt/future schemas are never auto-repaired.

## Rendered service

After deployment authorization, render placeholders in `dlmf-digital-life-stack.service.in` with the approved service user/group, Node binary, and exact reviewed DLMF checkout. The unit intentionally invokes the DLMF-owned ingress server directly and grants durable writes only under `/var/lib/dlmf/digital-life-stack`.

Do not install, enable, start, restart, or route traffic to the unit as part of code review. Those are production activation actions and require a separate authorization boundary.

## Acceptance

After an authorized service start:

```bash
curl -fsS http://127.0.0.1:8794/health
curl -fsS http://127.0.0.1:8794/ready
```

Both responses must report:

```text
contract=dlmf/digital-life-stack/v1
canonicalAuthority=digital-life-memory-fabric
```

`/ready` must report `schemaState=current-0007`. Digital-Life-Stack must reject the integration if the endpoint is unavailable, malformed, stale, or reports a different contract/authority.

## Rollback

Code rollback: stop routing to the candidate and return to the previously reviewed compatible DLMF service revision. Do not rewrite Canonical Memory or delete migration/audit evidence.

Database rollback: never attempt automatic reverse migration. Restore the protected pre-upgrade PostgreSQL backup only under a separately reviewed destructive-data recovery plan.

Provider rollback: Hindsight projection is derived state and may be rebuilt. Provider rollback must not alter canonical PostgreSQL identity/history.
