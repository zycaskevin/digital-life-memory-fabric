# Digital Life Memory Fabric

Provider-neutral canonical memory and synchronization layer for one Digital Life.

> No matter whether a Life runs on GB10, Mac, Hermes, OpenClaw, Prime, Vault, Hindsight, or Mem0, its formally committed memory identity, provenance, revision history, and continuity must remain the same.

## Status

- Canonical contract: v0.1 proposed/frozen for implementation
- Current milestone: **DLFM-001 — Canonical Core**
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
- canonical verification
- provider materialization mappings
- device checkpoint schema

It does **not** own provider selection or provider internals. OmniHarness owns provider registry/resolution/health/fallback/adapters. Hindsight, Vault, Mem0, pgvector, local FTS, graphs, embeddings, and reranking state are rebuildable derived/provider state.

## DLFM-001 implemented vertical slice

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
```

The PostgreSQL adapter uses:

- `SELECT ... FOR UPDATE` for canonical head mutation serialization
- namespace-scoped transactional sequence rows
- transaction advisory locks for idempotency keys
- immutable revision inserts
- atomic change/outbox writes in the same transaction

## Development

```bash
npm install
npm run check
```

`npm run check` runs typecheck, tests, and build.

### Real PostgreSQL integration gate

The integration test is intentionally opt-in because the current Workspace does not have Docker or `psql` installed.

```bash
DLFM_TEST_DATABASE_URL='postgres://...' npm test
```

The test creates an isolated temporary schema, applies `0001_canonical_core.sql`, runs the canonical create/update/conflict/tombstone E2E, and drops the schema afterward.

## Core invariant

Provider state is disposable. Canonical memory is not.
