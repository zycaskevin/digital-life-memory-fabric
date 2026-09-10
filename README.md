# Digital Life Memory Fabric

Provider-neutral canonical memory and synchronization layer for one Digital Life.

> No matter whether a Life runs on GB10, Mac, Hermes, OpenClaw, Prime, Vault, Hindsight, or Mem0, its formally committed memory identity, provenance, revision history, and continuity must remain the same.

## Status

- Canonical baseline: v0.1 frozen at tag `v0.1.0`
- Active canonical amendment: **v0.1.1 — Memory Distillation & Provider Boundary**
- Current milestone: **DLMF v0.1.1 — Governed Reflective Insight Promotion Hardening (DLMF-SG-009)**
- Runtime: Node.js 22 + strict TypeScript
- Canonical persistence target: PostgreSQL

Decision records: [DLMF-SG-002 concurrency, multilingual semantics, and insight promotion](docs/dlmf-sg-002-concurrency-multilingual-promotion.md), [DLMF-SG-003 Production Pilot epistemic remediation](docs/dlmf-sg-003-production-pilot-epistemic-remediation.md), [DLMF-SG-004 Production preference-boundary remediation](docs/dlmf-sg-004-production-preference-boundary-remediation.md), [DLMF-SG-005 reflection and retention completion](docs/dlmf-sg-005-reflection-retention-completion.md), [DLMF-SG-006 reviewed semantic concept registry](docs/dlmf-sg-006-reviewed-semantic-concept-registry.md), [DLMF-SG-007 semantic review queue and canary gate](docs/dlmf-sg-007-semantic-review-queue-and-canary.md), [DLMF-SG-008 production canary semantic remediation](docs/dlmf-sg-008-production-canary-semantic-remediation.md), and [DLMF-SG-009 governed insight promotion hardening](docs/dlmf-sg-009-governed-insight-promotion-hardening.md).

## Architectural boundary

Digital Life Memory Fabric owns:

- `MemoryCandidate` with per-memory type, speaker provenance, explicit epistemic status, DLMF semantic key, and provider-independent fingerprint
- provider-independent `memory_id`
- Canonical Memory Authority
- canonical content and immutable revisions
- evidence, raw-experience provenance, and producer provenance
- provider-neutral `MemoryDistillationProvider` contract
- durable `DistillationReceipt` lifecycle
- raw archive identity/checksum lifecycle through `RawExperienceArchiveProvider`
- explainable prune-eligibility decisions (never Hermes deletion)
- optimistic revision checks
- tombstones
- audited semantic equivalence/subsumption evidence merges
- first-class reflective insights and an explicit, audited promotion workflow
- content-minimized semantic review cases, append-only decisions, and read-only canary eligibility
- namespace-scoped `commit_seq`
- change log and transactional outbox
- ordered change replay and device checkpoint acknowledgement
- canonical verification
- provider materialization mappings
- versioned OmniHarness materialization events and receipt verification
- provider-neutral retrieval and canonical hydration
- device checkpoint schema

It does **not** own provider selection, provider internals, or Hermes SQLite maintenance. OmniHarness may own provider registry/resolution/health/fallback. Hindsight is the first Memory Intelligence / Distillation Provider, never canonical authority. Hindsight, Vault, Mem0, pgvector, local FTS, graphs, embeddings, and reranking state remain rebuildable derived/provider state.

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

`merge` is enabled only for a DLMF-policy semantic-key match backed by an admitted curation record. It preserves the canonical memory ID/content and adds an immutable evidence-union revision. Provider/model-proposed fuzzy merges remain review-only. `supersede` remains disabled pending multi-record lifecycle rules.

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

## DLFM-005A live materialization

`HttpMemoryMaterializationDeliveryPort` provides one bounded HTTP execution of the
same OH-MEM-002 contract. It forwards the worker abort signal, carries stable
request/idempotency headers, rejects endpoint credentials, and fails closed on
non-success, non-JSON, invalid, empty, or oversized responses. Retry and
settlement remain in `MaterializationWorker`; the port also enforces a bounded
standalone request deadline as transport-level defense in depth. Caller-supplied
headers require HTTPS so configured credentials cannot be sent in cleartext.

The opt-in live gate connects real PostgreSQL through this HTTP boundary to the
OmniHarness v0.2.0 consumer and Hindsight 0.9.2:

```bash
DLFM_TEST_DATABASE_URL='postgres://...' \
OMNIHARNESS_HINDSIGHT_DATABASE_URL='postgres://.../isolated_hindsight_test' \
OMNIHARNESS_DIR='/path/to/OmniHarness' \
bash scripts/run-live-omniharness-hindsight-local.sh
```

See [`docs/dlfm-005a-live-materialization.md`](docs/dlfm-005a-live-materialization.md)
for the exact acceptance and non-claims.

## DLFM-005B verified retrieval

`VerifiedRetrievalService` executes provider-neutral search through an injected
`MemoryRetrievalPort`, validates the provider response as untrusted evidence,
deduplicates canonical IDs, and hydrates only the current canonical revision.
Provider order and score are retained as retrieval evidence but never replace
canonical content.

Verification fails closed for scope mismatch, stale provider revision,
tombstone, supersession, missing or corrupt revisions, temporal invalidity, and
canonical head movement during hydration. Reads use bounded input/response size,
a bounded execution deadline, batch PostgreSQL head/revision hydration, and a
final optimistic head consistency check.

The opt-in live gate proves real Hindsight candidates flow through OmniHarness
`memory.search` and cannot bypass canonical state:

```bash
DLFM_TEST_DATABASE_URL='postgres://...' \
OMNIHARNESS_HINDSIGHT_DATABASE_URL='postgres://.../isolated_hindsight_test' \
OMNIHARNESS_DIR='/path/to/OmniHarness-v0.2.0' \
npm run e2e:verified-retrieval
```

See [`docs/dlfm-005b-verified-retrieval.md`](docs/dlfm-005b-verified-retrieval.md)
for the exact acceptance, temporal semantics, and non-claims.

## v0.1.1 memory distillation amendment

The transcript-to-memory lifecycle is now explicit:

```text
Hermes transcript
  -> RawExperienceArchiveProvider
  -> MemoryDistillationProvider (Hindsight first)
  -> MemoryCandidate
  -> DLMF governance
  -> CanonicalMemory
  -> DistillationReceipt COMPLETE
  -> PruneEligibilityDecision
  -> external Hermes maintenance owner
```

Hindsight uses separate **distillation** and **canonical projection** planes. Provider
output has no canonical IDs and cannot call canonical commit directly. Reflective
output becomes a `derived_insight_candidate` with inferred/synthesized/uncertain
epistemic status and remains `PENDING` until separately governed.

A completed distillation may legitimately contain zero canonical memories. Archive
durability plus an explicit governed `no_memory_worthy_content`, `rejected`, or
`superseded` result can still satisfy retention policy. DLMF returns an explainable
prune decision but contains no Hermes deletion implementation.

Governed tombstones preserve the semantic fingerprint, preventing later raw-archive
re-distillation from silently resurrecting forgotten canonical semantics.

See:

- [v0.1.1 canonical amendment](docs/memory-distillation-provider-boundary-v0.1.1.md)
- [MD-001 through MD-009 acceptance ledger](docs/dlfm-md-001-009-acceptance.md)

## Nancy production pilot runner

A host-side production pilot runner is available for the v0.1.1 amendment:

```bash
npm run pilot:memory-distillation
```

Plan mode is read-only against Hermes and selects five completed-session samples.
`--apply` requires an explicit PostgreSQL URL and writes only to isolated
`dlmf_pilot_*` schema / `pilot.*` namespace / Hindsight pilot banks. It never
executes Hermes pruning. See
[the production pilot runbook](docs/production-memory-distillation-pilot-v0.1.1.md).

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
migrations/0003_memory_distillation.sql
migrations/0004_canonical_admission.sql
migrations/0005_semantic_governance.sql
migrations/0006_semantic_review_queue.sql
migrations/0007_insight_promotion_governance.sql
```

The PostgreSQL adapter uses:

- `SELECT ... FOR UPDATE` for canonical head mutation serialization
- namespace-scoped transactional sequence rows
- transaction advisory locks for idempotency keys
- scope/semantic-key uniqueness with bounded loser-to-merge retry
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

The test creates an isolated temporary schema, applies all migrations,
runs the canonical create/update/conflict/tombstone flow plus durable distillation-receipt
round-trip, device pull/checkpoint replay, central outbox operations, and provider-neutral materialization delivery,
then drops the schema afterward.

## Core invariant

Provider state is disposable. Canonical memory is not.
