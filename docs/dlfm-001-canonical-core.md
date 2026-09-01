# DLFM-001 — Canonical Core

**Status:** Complete and frozen at `v0.1.0`.
**Canonical baseline:** `docs/canonical-memory-model-v0.1.md`

## Goal

Prove the smallest authoritative memory path before integrating any memory provider:

```text
Runtime/Test Producer
      -> MemoryCandidate
      -> CanonicalMemoryAuthority
      -> Canonical Store
      -> MemoryRevision + ChangeEnvelope + Outbox
      -> CanonicalVerifier
```

## Implemented

### Domain

- Provider-independent IDs: `cand_*`, `mem_*`, `evt_*`, `out_*`, `conf_*`
- Explicit `MemoryScope = tenantId + lifeDid + memoryNamespace`
- Canonical classes: episode, semantic assertion, preference, relationship fact
- Candidate states
- Memory head/revision model
- Evidence/provenance
- Temporal semantics: observed/valid-from/valid-until
- Change envelope
- Outbox contract
- Provider materialization contract type
- Device checkpoint contract type

### Candidate ingestion

Validation includes:

- non-empty scope and Life identity
- `origin.lifeDid === scope.lifeDid`
- non-empty evidence
- confidence within `[0,1]`
- valid temporal timestamps/ranges
- create cannot carry a base revision
- non-create mutations require `baseMemoryId + baseRevision`

### Canonical Authority

Enabled:

- create
- corrective update
- tombstone
- restore

Reserved, intentionally not enabled in DLFM-001:

- supersede
- merge

Canonical commit semantics:

- idempotency key required
- stale base revision becomes `REVISION_CONFLICT`
- conflicting candidate is persisted as `CONFLICT`
- conflict is auditable in `memory_conflicts`
- conflicts do not consume canonical `commit_seq`
- successful mutation creates head/revision/change/outbox atomically
- revision rows are immutable
- tombstone/restore preserve prior canonical content and temporal validity

### In-memory reference store

Used for deterministic contract tests. Transactions are serialized and copy-on-write so failed work does not leak partial state.

### PostgreSQL reference store

`PostgresCanonicalMemoryStore` implements the same async store contract.

Concurrency protections:

1. Candidate rows are read `FOR UPDATE` during commit.
2. Existing memory heads are read `FOR UPDATE` before mutation.
3. Head updates require exact previous revision in SQL.
4. New `memory_id` collisions fail instead of upserting over another memory.
5. Namespace sequence generation is transactional.
6. Idempotency keys use transaction advisory locks plus a DB unique constraint.
7. Change and outbox rows are written in the canonical transaction.

### Canonical Verification

Provider-returned IDs are suppressed when:

- memory does not exist
- scope does not match
- head is tombstoned
- head is superseded
- current immutable revision is missing

Provider relevance never establishes canonical validity.

## PostgreSQL schema

Migration: `migrations/0001_canonical_core.sql`

Tables:

- `memory_candidates`
- `memory_heads`
- `memory_revisions`
- `memory_evidence`
- `memory_changes`
- `memory_outbox`
- `provider_materializations`
- `device_checkpoints`
- `memory_conflicts`
- `memory_namespace_sequences`

## Tests

Deterministic tests cover:

1. candidate -> canonical create
2. provider-independent memory identity
3. revision update
4. idempotent retry
5. stale writer conflict
6. no commit-sequence hole on conflict
7. tombstone suppression
8. namespace-local commit ordering
9. temporal semantics

A PostgreSQL E2E test is included and runs only when `DLFM_TEST_DATABASE_URL` is supplied. It creates and destroys an isolated schema.

## DLFM-001 acceptance boundary

DLFM-001 is complete when:

- local typecheck/test/build are green
- PostgreSQL adapter compiles against the canonical store contract
- migration and PostgreSQL E2E are present
- one real PostgreSQL E2E is executed successfully

All four acceptance gates passed against commit
`7d7b97871f6efbf89511d39f6f3c6bf5169381a8` on 2026-09-01. The real PostgreSQL
run completed with six passing tests, zero skips, and no remaining temporary schema.

## Next milestone

**DLFM-002 — Change & Device Sync**

Planned focus:

- device checkpoint service
- `changesSince(lastAppliedCommitSeq)` sync contract
- checkpoint ACK rules
- replay/idempotent apply semantics
- sync tests across GB10/Mac-style logical devices

Offline pending journals remain a separate runtime contract and are not required for
the canonical change-feed/checkpoint slice.

Do not connect Hindsight/Vault/Mem0 before the canonical sync path is proven.
