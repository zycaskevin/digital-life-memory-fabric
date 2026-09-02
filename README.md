# Digital Life Memory Fabric

Provider-neutral canonical memory and synchronization layer for one Digital Life.

> No matter whether a Life runs on GB10, Mac, Hermes, OpenClaw, Prime, Vault, Hindsight, or Mem0, its formally committed memory identity, provenance, revision history, and continuity must remain the same.

## Status

- Canonical contract: v0.1 frozen at tag `v0.1.0`
- Current milestone: **DLFM-004 — Provider Materialization Worker**
- Runtime: Node.js 22 + strict TypeScript
- Canonical persistence target: PostgreSQL

## Architectural boundary

Digital Life Memory Fabric owns:

- `MemoryCandidate`
- provider-independent `memory_id`
- Canonical Memory Authority
- canonical content and immutable revisions
- evidence and provenance
- optimistic revision checks
- tombstones
- namespace-scoped `commit_seq`
- change log and transactional outbox
- ordered change replay and device checkpoint acknowledgement
- canonical verification
- provider materialization mappings
- versioned OmniHarness materialization events and receipt verification
- device checkpoint schema

It does **not** own provider selection or provider internals. OmniHarness owns provider registry/resolution/health/fallback/adapters. Hindsight, Vault, Mem0, pgvector, local FTS, graphs, embeddings, and reranking state are rebuildable derived/provider state.

## DLFM-001 canonical vertical slice

```text
MemoryCandidate
      |
      v
CanonicalMemoryAuthority
      |
      +-- scope / identity validation
      +-- base_revision validation
      +-- idempotency guard
      +-- revision conflict audit
      |
      v
Canonical Store transaction
      +-- memory_heads
      +-- memory_revisions
      +-- memory_evidence
      +-- memory_changes
      +-- memory_outbox
      |
      v
CanonicalVerifier
```

Enabled commit operations in DLFM-001:

- `create`
- `update`
- `tombstone`
- `restore`

`supersede` and `merge` are reserved by the v0.1 domain contract but intentionally not enabled yet. They require the later multi-record lifecycle rules rather than an unsafe partial implementation.

## Commit ordering

`commit_seq` is monotonic inside exactly one scope:

```text
(tenant_id, life_did, memory_namespace)
```

A revision conflict does not consume a commit sequence number.

## DLFM-002 change and device sync

`MemorySyncService` exposes three bounded operations:

- `readChanges` / `replay` reads an ordered page after a namespace `commit_seq`
- `pullForDevice` reads from the device's durable checkpoint without advancing it
- `acknowledgeDeviceChanges` advances a checkpoint only after a contiguous apply

Checkpoint writes use compare-and-set semantics. A stale device cannot overwrite a
newer checkpoint, checkpoints cannot move backward, and an acknowledgement cannot
jump across a missing canonical change.

## DLFM-003 central operations

`CentralOperationsService` adds the bounded backend needed to operate one canonical
namespace:

- current-memory inventory with immutable revision hydration
- device checkpoint inventory with high-watermark lag
- provider materialization inventory
- memory/outbox/device/materialization summary counts
- concurrent outbox worker claims with lease expiry and fencing tokens
- atomic successful or failed outbox settlement plus materialization status

PostgreSQL workers use `FOR UPDATE SKIP LOCKED`, and Provider network calls remain
outside database transactions. This layer does not provide HTTP/UI, caller
authentication, Provider selection, deployment, or real Provider delivery.

## DLFM-004 provider materialization worker

`MaterializationWorker` turns a fenced canonical Outbox claim into the versioned
OmniHarness `OH-MEM-002` wire contract:

```text
memory.materialization.requested / version 1
```

The worker preserves the canonical change `event_id`, derives stable request and
materialization idempotency keys, maps tombstones to `DELETE`, validates every
receipt correlation field, and atomically settles Provider success or retryable
failure. Transport failure before Provider selection schedules the Outbox retry
without inventing a Provider materialization row.

`MemoryMaterializationDeliveryPort` is provider-neutral and returns an untrusted
receipt. OmniHarness still owns Provider registry, selection, health, and adapter
execution. DLFM-004 does not add a production transport or Provider dependency.

## Temporal semantics

The canonical model distinguishes:

- candidate `created_at`
- canonical `committed_at`
- `observed_at`
- `valid_from`
- `valid_until`

Learning a historical fact today therefore does not rewrite the time at which that fact was valid.

## PostgreSQL

Migration:

```text
migrations/0001_canonical_core.sql
migrations/0002_central_operations.sql
```

The PostgreSQL adapter uses:

- `SELECT ... FOR UPDATE` for canonical head mutation serialization
- namespace-scoped transactional sequence rows
- transaction advisory locks for idempotency keys
- immutable revision inserts
- atomic change/outbox writes in the same transaction
- partial indexes plus `SKIP LOCKED` for bounded outbox claims
- claim-token fencing and atomic materialization settlement

## Development

```bash
npm install
npm run check
```

`npm run check` runs typecheck, tests, and build.

### Real PostgreSQL integration gate

The integration test is opt-in so callers can supply an isolated PostgreSQL database.

```bash
DLFM_TEST_DATABASE_URL='postgres://...' npm test
```

The test creates an isolated temporary schema, applies both migrations,
runs the canonical create/update/conflict/tombstone flow plus device pull/checkpoint
replay, central outbox operations, and provider-neutral materialization delivery,
then drops the schema afterward.

## Core invariant

Provider state is disposable. Canonical memory is not.
