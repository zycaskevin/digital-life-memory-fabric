# DLMF-HIST-LIVE-001 — Historical Canonical Activation & Retrieval View

**Date:** 2026-09-20  
**Status:** Memory View implementation + disposable live UAT PASS; Nancy existing-resident production binding pending  
**Life:** `did:arthurverse:nancy`

## Purpose

The completed Hermes historical migration must become usable by the living Nancy without:

- renaming a pilot namespace into production;
- copying/re-authoring historical Canonical Memory into another scope;
- granting Digital-Life-Stack or Hindsight memory authority;
- creating a second Nancy runtime;
- allowing a new preference/forget decision in the living scope to be overridden by stale historical truth.

DLMF therefore exposes a **Verified Retrieval Memory View**.

## Authority model

Public writable scope:

```
tenantId: tenant-arthur
lifeDid: did:arthurverse:nancy
memoryNamespace: life
```

Historical mount remains where it was originally committed:

```
schema: dlmf_pilot_hermes_adapter_direct1000_shadow_v3
tenantId: arthurverse-hermes-migration-pilot
lifeDid: did:arthurverse:nancy
memoryNamespace: pilot.hermes-historical-migration.direct1000-v1
mode: read_only_historical
```

DLS submits only the public `life` scope. DLMF owns the view.

Each mounted source independently runs:

```
Hindsight candidate search
  -> CanonicalVerifier in the mount's ORIGINAL scope
  -> verified Canonical revision
```

Only verified items are merged. The view never rewrites `revision.scope`, never changes provenance, and never treats provider text as Canonical Memory.

## Living-memory precedence

The writable primary `life` scope shadows historical Canonical Memory by semantic key:

1. no primary current revision -> historical verified item may be returned;
2. primary ACTIVE current revision -> primary revision replaces the historical hit;
3. primary TOMBSTONED/SUPERSEDED current revision -> historical hit is suppressed.

This makes preference changes and governed forgetting durable across the historical mount without mutating historical evidence.

Primary freshness watermarks are not applied to historical mounts because commit sequence domains are scope-local.

## Configuration

Optional ingress configuration:

```
DLMF_DLS_RETRIEVAL_VIEW_FILE=/private/path/view.json
```

Config schema:

```
dlmf.verified-retrieval-view.v1
```

The manifest is accepted only when it is an owner-private, non-symlink regular JSON file. It binds one public scope and 1..8 unique `read_only_historical` mounts with the same life DID.

Every mounted PostgreSQL schema must independently satisfy `current-0008`. Any invalid/unready mount fails service composition closed.

## Public API

The existing DLS endpoint is unchanged:

```
POST /v1/digital-life-stack/retrievals
```

The response remains DLMF Canonical hydration and may additionally contain a content-free `view` observation:

- `viewId`
- `mountCount`
- `primaryOverrides`
- `primarySuppressions`
- `mountedAllowed`

No mount schema, memory text from suppressed candidates, or provider bypass handle is exposed.

## Regression acceptance

The Memory View suite proves:

- public `life` scope can expose a verified historical revision while preserving its original scope;
- primary current semantic memory overrides historical truth even if the primary provider search missed it;
- primary tombstone suppresses the corresponding historical semantic key;
- duplicate primary/historical semantic results do not produce duplicate live memories;
- foreign-life mounts, wrong public scope and mount scope escape fail closed;
- config accepts only exact same-life read-only mounts.

Full repository gate after implementation:

- TypeScript typecheck: PASS;
- core tests: 208 total / 200 passed / 0 failed / 8 environment-gated skipped;
- standalone projection/retry tests: 29 / 29 passed;
- build: PASS;
- `git diff --check`: PASS.

## Disposable live UAT

A disposable primary schema was bootstrapped on the existing DLMF PostgreSQL instance:

```
dlmf_nancy_memory_view_uat_20260920
```

It was bound to the public Nancy scope `tenant-arthur / did:arthurverse:nancy / life`.

The real completed historical destination was mounted read-only with its real Hindsight canonical projection. The ingress was started loopback-only on a temporary port and queried through the normal authenticated DLS retrieval endpoint.

Observed content-free evidence:

- primary bootstrap: `current-0008`, 8 migrations applied;
- ingress: `scope_bound=true`, `retrieval_view=nancy-life-uat`;
- retrieval provider: `dlmf-memory-view:nancy-life-uat`;
- received candidates: 5;
- allowed Canonical items: 5;
- mountCount: 1;
- mountedAllowed: 5;
- primaryOverrides: 0;
- primarySuppressions: 0;
- historical schema counts before/after were unchanged;
- historical head-state fingerprint before/after was identical;
- temporary primary schema was removed after UAT.

Result:

```
DLMF_HIST_LIVE_VIEW_UAT=PASS
```

## Existing-resident boundary

Nancy is not provisioned like Lily/Luna. She already owns the global Hermes home, system Life Runtime, Lifetime Hub continuity and resident HLB path. This work must therefore bind a DLMF `life` primary scope to the existing Nancy; it must not create a replacement conversation runtime or second Nancy.

The existing `development.reference-only` resident evidence stream remains separate. Development evidence is not Canonical Memory and must not be promoted merely to make the Memory View work.

## Next gate

Provision a reversible existing-resident Nancy DLMF memory binding that:

1. creates/validates one dedicated `dlmf_dl_nancy_v1` primary schema;
2. binds it to `tenant-arthur / did:arthurverse:nancy / life`;
3. installs an owner-private Memory View manifest mounting the completed historical store;
4. starts a loopback DLMF ingress using the existing-resident Nancy identity;
5. proves historical recall through the public `life` scope;
6. proves a new real Nancy conversation can enter the primary `life` scope through the governed DLMF pipeline;
7. proves a new primary preference overrides a historical semantic match;
8. proves a primary tombstone suppresses historical recall;
9. records content-free retrieval/use evidence for ACP/observability.

No Lifetime Hub identity/schema migration is part of this gate.
