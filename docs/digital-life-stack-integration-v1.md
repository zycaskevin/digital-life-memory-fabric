# DLMF → Digital-Life-Stack Integration v1

**Date:** 2026-09-10
**Status:** Implementation candidate
**Formal upper integration target:** `Digital-Life-Stack` only

## 1. Decision

Digital Life Memory Fabric (DLMF) is the Canonical Memory Authority. Digital-Life-Stack (DLS) is a consumer/orchestrator and release-integration control plane. DLS does not own canonical memory identity, candidate admission, semantic merge proof, insight-promotion records, canonical commit sequencing, or canonical PostgreSQL truth.

Relationship OS is not a DLMF consumer. Earlier Relationship OS ingress/deployment artifacts in this repository are retained only as historical/development evidence and compatibility references. They must not be used to infer current production architecture or a future Relationship OS DLMF migration. No Relationship OS service, schema, deployment, or runtime restart is part of this packet.

## 2. Ownership boundary

```text
Digital-Life-Stack
  owns: component composition, exact revision locks, compatibility gates,
        integration journeys, readiness evidence, release acceptance
          |
          | authenticated bounded contract
          v
Digital Life Memory Fabric
  owns: raw-experience archive boundary, provider invocation, curation,
        canonical admission, semantic governance, canonical identity,
        canonical commits, promotion governance, verified retrieval
          |
          +--> Hindsight MemoryDistillationProvider
          |      provider output = evidence/candidates only
          |
          +--> Hindsight canonical projection
                 derived retrieval index only; never canonical truth
```

DLS never receives a `CanonicalMemoryAuthority`, `PostgresCanonicalMemoryStore`, promotion store, or provider-selection handle from the DLMF runtime factory.

## 3. Formal service contract

Contract identity: `dlmf/digital-life-stack/v1`.

DLMF exposes only:

- `GET /health` — process liveness and immutable contract/authority identity.
- `GET /ready` — schema/readiness gate; returns HTTP 503 when stale, partial, future, or unavailable.
- `POST /v1/digital-life-stack/experiences` — authenticated experience ingestion into the DLMF distillation/admission pipeline.
- `POST /v1/digital-life-stack/retrievals` — authenticated verified retrieval; provider candidates are re-hydrated and verified against DLMF canonical PostgreSQL state.

There is deliberately no canonical commit endpoint and no insight-promotion endpoint. Request objects are exact-key validated. Caller-supplied canonical IDs, promotion IDs, provider controls, canonical authority labels, policy versions, or author identity are rejected instead of ignored.

The ingress derives `origin.lifeDid` from the requested DLMF scope and injects the configured DLS agent/runtime identity. Distillation, canonicalization, admission, and retention policy versions are server configuration rather than caller input.

## 4. Hindsight boundary

Hindsight is instantiated only inside the DLMF-owned service composition:

- `HindsightMemoryAdapter` implements `MemoryDistillationProvider`.
- `HindsightCanonicalProjectionPort` is a derived search projection.
- Hindsight cannot allocate canonical memory IDs, update canonical heads, create promotion records, or execute canonical commits.
- Retrieval uses Hindsight only to obtain candidate canonical IDs/revisions; final text is read from and verified against DLMF canonical storage.

Canonical projection is failure-isolated. A provider projection failure cannot roll back an already committed canonical transaction. Replaying the same DLMF idempotent experience can repair the derived projection without creating a second canonical memory.

## 5. PostgreSQL schema contract

DLS does not own a memory database. The configured PostgreSQL schema is a DLMF-owned canonical schema used by the DLS integration composition.

Expected schema state: `current-0007`.

Bootstrap classifications:

| State | Default behavior |
| --- | --- |
| empty | Apply DLMF migrations 0001–0007 |
| current-0007 | Verify only; zero migration writes |
| stale-0005 / stale-0006 | Fail closed unless `DLMF_DLS_ALLOW_UPGRADE=1` |
| partial/corrupt/future | Always fail closed; no automatic repair |

Bootstrap takes a PostgreSQL advisory lock per schema. Migration 0006 and 0007 ledger rows must each exist exactly once. Readiness additionally checks key semantic/promotion columns and append-only review/promotion event triggers.

A schema upgrade is therefore distinct from normal startup. Setting `DLMF_DLS_ALLOW_UPGRADE=1` is an explicit upgrade action and must only be used under an approved deployment change.

## 6. Configuration

Required for bootstrap/readiness:

```text
DLMF_DLS_DATABASE_URL
DLMF_DLS_SCHEMA=dlmf_digital_life_stack
```

Required for the DLMF-owned ingress service:

```text
DLMF_DLS_DATABASE_URL
DLMF_DLS_SCHEMA
DLMF_DLS_ARCHIVE_ROOT
DLMF_DLS_BEARER_TOKEN
DLMF_DLS_HINDSIGHT_URL
OMNIHARNESS_DIR
```

Optional service settings:

```text
DLMF_DLS_HOST=127.0.0.1
DLMF_DLS_PORT=8794
DLMF_DLS_HINDSIGHT_API_KEY
DLMF_DLS_HINDSIGHT_BANK_PREFIX=dlmf-dls
DLMF_DLS_AGENT_ID=digital-life-stack
DLMF_DLS_PG_POOL_MAX=4
DLMF_DLS_DISTILLATION_POLICY=dls-distill-v1
DLMF_DLS_CANONICALIZATION_POLICY=dls-canonical-v1
DLMF_DLS_ADMISSION_POLICY=dls-admission-v1
DLMF_DLS_RETENTION_POLICY=dls-retention-v1
```

The service refuses non-loopback binding. A remote Hindsight endpoint must be HTTPS and authenticated. Hindsight SDK loading occurs on the DLMF side from the approved OmniHarness installation; the DLS caller cannot select or configure a provider in a request.

## 7. Startup and readiness

Repository-only commands:

```bash
npm run build
node scripts/digital-life-stack-bootstrap.mjs
node scripts/digital-life-stack-health.mjs
node scripts/digital-life-stack-ingress-server.mjs
```

Starting the ingress is not production activation. Production service installation, secret provisioning, routing, or restart requires a separate deployment authorization.

DLS must treat `/ready != 200`, wrong contract identity, wrong canonical authority, an unexpected schema state, timeout, invalid JSON, or connection failure as `NOT_READY`.

## 8. Idempotency

Canonical idempotency remains a DLMF property. `TranscriptDistillationService` derives an idempotency key from scope, source identity, policies, provider identity, curation identity, and source projection fingerprint. Replaying a completed/awaiting-review receipt does not create a duplicate canonical result.

Schema bootstrap is also replay-safe: a `current-0007` schema performs zero migration writes, and ledger entries remain singletons.

## 9. Failure isolation

- DLMF unavailable → DLS readiness fails closed.
- stale schema → service readiness fails closed; normal startup cannot silently upgrade it.
- partial/future schema → bootstrap and readiness fail closed.
- Hindsight unavailable during distillation/retrieval → request fails; Hindsight never becomes canonical authority.
- canonical projection failure after commit → canonical truth remains committed; derived projection may be repaired by replay.
- caller authority bypass attempt → rejected by exact request schema or 404 because no direct authority endpoint exists.

## 10. Upgrade and rollback

Upgrade procedure:

1. Use a disposable schema to execute the full migration/replay/failure-mode gate.
2. Back up the target DLMF PostgreSQL schema under the deployment runbook.
3. Verify the exact reviewed DLMF revision and DLS compatibility lock.
4. Set `DLMF_DLS_ALLOW_UPGRADE=1` only for the controlled schema-upgrade invocation.
5. Remove the flag for ordinary startup.
6. Require `/ready` and the DLS integration gate before release acceptance.

Code rollback does not rewrite canonical history. Stop routing to the new ingress implementation and restore the previously reviewed compatible DLMF code. A database downgrade is never automatic; if an additive migration must be reversed, restore from the protected pre-upgrade backup under a separately reviewed destructive-data plan.

## 11. Test evidence required before activation

The integration gate must prove:

- fresh disposable PostgreSQL bootstrap;
- process restart/readiness;
- migration replay with zero duplicate ledger entries;
- stale schema fail-closed and explicit upgrade path;
- partial schema fail-closed;
- DLMF unavailable fail-closed at the DLS startup gate;
- wrong contract/authority fail-closed;
- caller canonical/promotion/provider bypass rejected;
- strict TypeScript typecheck, tests, build, and `git diff --check`.

This document does not authorize deployment or production activation.
