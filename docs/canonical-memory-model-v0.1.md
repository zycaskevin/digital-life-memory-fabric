# Digital Life Memory Fabric v0.1

## Canonical Memory Model

**Date:** 2026-09-01  
**Status:** Proposed Canonical Contract / DLFM-001 implementation baseline  
**Repository:** `digital-life-memory-fabric`  
**Scope:** Lifetime Hub / Life Runtime / Agent Factory / Self Gateway / OmniHarness / Hermes / OpenClaw / Prime / future runtimes

## 1. Purpose

Digital Life Memory Fabric does not answer which vector database or memory provider is best. It answers a more fundamental question:

> What does one Digital Life formally remember?

Memory providers may be replaced. Canonical Memory must not lose identity, history, or truth merely because a provider changes.

```text
Raw Experience / Runtime Event
              |
              v
       Memory Candidate
              |
              v
        Normalization
              |
              v
    Governance / Validation
              |
              v
    Canonical Memory Commit
              |
              v
     Canonical Memory Store
              |
              v
        Change / Outbox
              |
              v
          OmniHarness
       /       |       \
      v        v        v
 Hindsight    Vault     Mem0
```

## 2. Canonical principle

Canonical Memory stores information that must not disappear when a provider disappears:

- memory identity
- canonical content
- Life identity scope
- semantic meaning
- temporal meaning
- provenance
- evidence
- revision history
- supersession history
- deletion state
- commit history

The following are rebuildable derived/provider state and are not Canonical Memory:

- provider embeddings
- Hindsight internal graph
- Mem0 internal IDs
- Vault internal indexes
- provider search scores
- temporary reranking scores
- runtime scratchpads
- model-specific KV caches

## 3. Memory Fabric is not a giant provider database

Forbidden model:

```text
Vault DB + Hindsight DB + Mem0 DB = Canonical DB
```

Correct model:

```text
             Canonical Memory
                    |
                    v
                OmniHarness
             /       |       \
            v        v        v
       Hindsight    Vault     Mem0
          View       View      View
```

Provider representations may include materialized views, retrieval indexes, graphs, vectors, and search accelerators. They are rebuildable from Canonical Memory.

## 4. Three memory layers

### Layer 1 — Canonical Memory

Answers: **What does this Digital Life formally remember?**

Contains identity, content, meaning, evidence, provenance, revision history, temporal state, and deletion state. Only this layer has Canonical Authority.

### Layer 2 — Derived Memory

Computed from Canonical Memory, for example summaries, entity extraction, relationship graphs, preference inference, topic clustering, reflection, dream outputs, and semantic compression.

Derived state is not Canonical Truth by default. It may produce a `MemoryCandidate`, which must pass canonical governance before commit.

### Layer 3 — Provider Materialization

Examples: Hindsight graph/index, Mem0 memory index, Vault retrieval index, pgvector embeddings, local FTS, local vector cache.

All provider materialization must be rebuildable.

## 5. Two different objects

The system MUST distinguish:

- `MemoryCandidate`
- `CanonicalMemoryRecord` / immutable canonical revision

A candidate means only: **the system believes this may be worth remembering.**

## 6. MemoryCandidate

Candidates may originate from conversation, Hermes, OpenClaw, Prime, Life Runtime, explicit user correction, reflection, Hindsight inference, task completion, relationship events, or external sources.

Minimum conceptual shape:

```yaml
candidate_id: cand_...
scope:
  tenant_id: tenant_01
  life_did: did:life:nancy
  memory_namespace: life.core
origin:
  agent_id: nancy
  runtime_id: hermes-gb10
  device_id: gb10
source_type: conversation
candidate_type: semantic_assertion
proposed_content:
  text: "OmniHarness does not own Agent orchestration."
evidence_refs:
  - conversation:2026-09-01:message:123
confidence: 0.96
proposed_operation: create
base_memory_id: null
base_revision: null
status: PENDING
```

Candidate states:

```text
PENDING | ACCEPTED | REJECTED | CONFLICT | EXPIRED
```

Deleting a candidate must never delete an already committed Canonical Memory.

## 7. Canonical Memory Record

Only a successful Canonical Commit produces formal memory.

Conceptual shape:

```yaml
memory_id: mem_...
scope:
  tenant_id: tenant_01
  life_did: did:life:nancy
  memory_namespace: life.core
memory_class: semantic_assertion
memory_kind: architecture_boundary
revision: 1
status: active
canonical_content:
  text: "OmniHarness does not own Agent orchestration."
committed_at: ...
commit_seq: 10527
author:
  agent_id: nancy
  runtime_id: hermes-gb10
  device_id: gb10
evidence_refs:
  - conversation:2026-09-01:message:123
provenance:
  source_type: conversation
  candidate_id: cand_...
content_hash: sha256:...
```

## 8. Global memory identity

Every formal memory uses a provider-independent `memory_id` such as `mem_...`, never a provider ID such as `hindsight_28371`, `vault_827`, or `mem0_99172`.

Provider mapping is secondary:

```yaml
memory_id: mem_01KABC
provider_materializations:
  hindsight:
    provider_id: h_392
  vault:
    provider_id: v_827
  mem0:
    provider_id: m_99172
```

Canonical IDs remain stable across provider migration, device migration, embedding replacement, vector rebuild, runtime replacement, and infrastructure migration.

## 9. Canonical content ownership

Canonical content must be owned or durably referenced by Memory Fabric. A provider-internal object reference cannot be the sole content source.

Small textual memory may live directly in PostgreSQL (`canonical_text`, `canonical_payload JSONB`). Large binary/media artifacts should use provider-neutral durable object storage and canonical object references plus content hashes.

## 10. Memory scope

Every operation must include:

```text
tenant_id + life_did + memory_namespace
```

Example namespaces:

- `life.core`
- `relationship:<relationship_id>`
- `project:<project_id>`
- `character:<character_id>`
- `private-agent:<agent_id>`

Namespaces organize data; they do not replace identity or authorization.

## 11. Canonical memory classes

v0.1 defines four primary classes:

1. `episode` — what happened; normally append-oriented, timestamped, evidence-oriented.
2. `semantic_assertion` — what the system currently believes is true; requires evidence, provenance, revision and conflict handling.
3. `preference` — an explicit semantic subtype with confidence/evidence/validity so one-off behavior does not become permanent preference.
4. `relationship_fact` — shared events, facts, milestones, commitments, and governed relationship state. Scores such as affection/attachment are normally derived state unless promoted through formal Life/Relationship governance.

## 12. What is not Canonical Memory

Not canonical by default:

- chain-of-thought
- scratchpads
- temporary reasoning/context/session variables
- raw provider inference
- temporary retrieval/ranking/query-expansion state
- agent capability improvements (these belong to Agent Factory Capability Lifecycle governance)

Provider inference can produce a candidate; it cannot silently become Canonical Truth.

## 13. Revision vs supersession

**Correction -> revision.** The same assertion was wrong or imprecise and is corrected under the same `memory_id`, incrementing revision.

**World-state change -> supersession.** The old fact may remain historically true, while a new memory supersedes it with explicit temporal validity.

DLFM-001 enables correction revisions. Full supersession/merge mutation semantics are reserved for the later lifecycle milestone and MUST NOT be partially emulated by destructive overwrite.

## 14. Temporal semantics

Canonical Memory distinguishes:

- candidate `created_at`
- canonical `committed_at`
- `observed_at`
- `valid_from`
- `valid_until`

A fact learned today may refer to a period in the past. Commit time must not be treated as fact-validity time.

## 15. Evidence and provenance

Canonical Memory must answer: **Why do we believe this?**

Evidence may refer to conversations, messages, documents, email, calendar events, task results, sensor observations, explicit user statements, other canonical memories, or LifeCommit.

Inference must not hide its evidence chain.

## 16. Confidence is not truth

Confidence is an assessment of evidence quality. It cannot replace provenance, evidence, revision history, or conflict handling.

## 17. Commit contract

All canonical mutation passes through exactly one Canonical Memory Authority.

Forbidden:

```text
Runtime -> Hindsight -> canonical
Runtime -> Vault + Mem0 as formal truth
```

Required flow:

```text
MemoryCandidate
      |
      v
Canonical Commit Request
      |
      +-- Identity Check
      +-- Authority Check
      +-- Revision Check
      +-- Validation
      v
Canonical Transaction
```

The same transaction writes the memory head/revision, change envelope and outbox event.

## 18. Commit sequence

`memory revision` and `commit_seq` are different.

- revision orders versions of one memory
- `commit_seq` orders successful canonical mutations inside one canonical namespace scope

v0.1 ordering scope is exactly:

```text
(tenant_id, life_did, memory_namespace)
```

Conflicts or rejected commits do not consume a successful canonical sequence position.

## 19. MemoryChangeEnvelope

Every successful mutation produces a change envelope containing event ID, scope, commit sequence, memory ID, operation, base/new revision, idempotency key, author, commit time, and payload hash.

Operations reserved by v0.1:

```text
create | update | supersede | tombstone | restore | merge
```

## 20. Conflict model

Updates require `base_revision`.

If a device proposes base revision 5 while canonical current revision is 6, Canonical Authority returns `REVISION_CONFLICT`. Silent overwrite is forbidden.

Conflict candidates remain auditable as `CONFLICT` and produce a `memory_conflicts` record.

## 21. Deletion model

Ordinary canonical deletion is a tombstone, not physical deletion.

A provider may still return an old materialization, but Canonical Verification suppresses it when the canonical head is tombstoned.

Physical purge is a separate lifecycle concern.

## 22. Provider materialization

Only successful canonical commits feed provider materialization through an outbox.

```text
Canonical Commit -> Outbox -> OmniHarness -> Hindsight / Vault / Mem0
```

Materialization state tracks provider, canonical revision, materialized revision, provider ID, status, last attempt, and error.

Statuses:

```text
CURRENT | LAGGING | FAILED | UNAVAILABLE | REBUILDING
```

## 23. Provider adapters

Adapters map canonical records to provider-specific representations and map provider results back to canonical `memory_id`.

Memory Fabric must not absorb provider internal schemas.

## 24. Retrieval contract

Provider search produces relevance candidates. It does not establish validity.

```text
Query
  -> OmniHarness provider retrieval
  -> canonical memory IDs
  -> Canonical Verification
  -> ranking / ContextProjection
  -> Runtime
```

Canonical verification checks tenant, Life identity, scope, current revision, tombstone/supersession state, and access validity.

## 25. Runtime L1 vs Canonical L2

Hermes/OpenClaw/Prime may keep runtime-local history, FTS, embeddings, or session memory as **Runtime L1 Memory**.

Digital Life Memory Fabric is **Canonical L2 Memory**.

L1 may be lost. L2 must not be lost because a runtime is replaced.

## 26. Cross-device sync

Devices track the last applied namespace commit sequence.

```yaml
device_id: gb10
life_did: did:life:nancy
memory_namespace: life.core
last_applied_commit_seq: 10527
```

Reconnect protocol conceptually requests changes after that sequence and applies them in order before advancing the device checkpoint.

## 27. Offline writes

Offline runtimes create local pending journal entries, not canonical commits. Reconnection submits them to Canonical Authority for commit or conflict resolution.

Runtime/UI must distinguish `LOCAL_PENDING` from `CANONICAL_COMMITTED`.

## 28. PostgreSQL reference model

v0.1 baseline tables:

- `memory_candidates`
- `memory_heads`
- `memory_revisions`
- `memory_evidence`
- `memory_changes`
- `memory_outbox`
- `provider_materializations`
- `device_checkpoints`
- `memory_conflicts`
- support table `memory_namespace_sequences`

Optional future tables include canonical objects and memory links.

## 29. memory_heads

Stores the current head only: memory identity, scope, class/kind, current revision, status, creation/update timestamps.

## 30. memory_revisions

Stores immutable revision history: canonical content/payload, status, content hash, author, provenance, evidence linkage, temporal semantics, commit time and sequence.

Revision rows are never overwritten.

## 31. memory_changes

Canonical change stream used for audit, sync, replay, debug, and reconciliation.

## 32. memory_outbox

Provider materialization work source. Canonical mutation and outbox creation must be atomic.

## 33. provider_materializations

Provider IDs are mappings only. They are never canonical identity.

## 34. device_checkpoints

Stores per-device last applied commit sequence for a Life namespace.

## 35. Read modes

- `STRONG`: direct canonical state; used for editing, identity-sensitive facts, deletion, authorization, conflict resolution, inspection.
- `VERIFIED_RETRIEVAL`: default agent path; provider retrieval -> canonical verification -> ContextProjection.
- `EVENTUAL`: analytics, background indexing, non-critical UI, speculative recommendations.

## 36. Repository boundary

`digital-life-memory-fabric` owns canonical memory contracts, candidate contracts, Canonical Authority, commit API, revision/supersession semantics, evidence/provenance, conflict/tombstone semantics, change stream, device sync, canonical verification, and provider materialization contracts.

It does not own:

- OmniHarness provider registry/resolver/health/fallback/adapter runtime
- Lifetime Hub Life identity/state/continuity/LifeCommit
- Agent Factory composition/routing/authority/capability lifecycle
- Self Gateway privacy/least-privilege ContextProjection
- Life Runtime living state/reflection/experience/contact decisions
- provider-specific Hindsight/Vault/Mem0 internals

## 37. Canonical invariants

- **CM1** Canonical Memory always has provider-independent `memory_id`.
- **CM2** Canonical content must not exist only inside a provider.
- **CM3** Provider internal schemas do not become the canonical schema.
- **CM4** Provider indexes are derived state.
- **CM5** `MemoryCandidate` is not Canonical Memory.
- **CM6** Every canonical mutation passes one Commit Authority.
- **CM7** Every successful canonical mutation has a unique canonical commit order within its scope.
- **CM8** Update requires `base_revision`.
- **CM9** Correction uses revision.
- **CM10** World-state change prefers supersession.
- **CM11** Ordinary deletion uses tombstone.
- **CM12** Provider failure must not cause canonical memory loss.
- **CM13** Runtime-local memory is not canonical by default.
- **CM14** Derived inference cannot auto-promote itself to Canonical Truth.
- **CM15** Every memory operation carries explicit Life identity scope.
- **CM16** Every provider can be deleted and rebuilt from canonical state.
- **CM17** Within `(tenant_id, life_did, memory_namespace)`, each successful canonical mutation receives a monotonically increasing `commit_seq`.

## 38. Reference architecture

```text
                    Lifetime Hub
                 Who is this Life?
                         |
                         v
              Digital Life Memory Fabric
     +-------------------+-------------------+
     |                   |                   |
Memory Candidates  Canonical Authority   Sync Fabric
                         |
                         v
                 Canonical PostgreSQL
                         |
                         v
                    OmniHarness
                Which Provider?
              /          |          \
             v           v           v
        Hindsight       Vault       Mem0
              \          |          /
               +---- Retrieval ----+
                         |
                         v
               Canonical Verification
                         |
                         v
                   Self Gateway
                 What can you know?
                         |
                         v
                 ContextProjection
              /          |          \
             v           v           v
          Hermes      OpenClaw      Prime
              \          |          /
               +-- Runtime L1 -----+
```

Agent Factory governs what an Agent may do. Life Runtime produces experiences/reflections that may become candidates.

## 39. Initial implementation principle

Do not begin with a general ontology, knowledge graph engine, custom vector database, AI truth-resolution engine, distributed consensus database, or multi-master canonical store.

First establish canonical identity/content, candidate ingestion, commit/revision, evidence, change log/outbox, provider mapping, device checkpoints, and canonical verification.

Keep Memory Fabric thin.

## 40. Definition

> **Digital Life Memory Fabric is the provider-neutral canonical memory and synchronization layer that preserves one Digital Life's memory identity, provenance, revision history and continuity across runtimes, devices and interchangeable memory providers.**

Plain language:

> No matter whether Nancy runs on GB10, Mac, OpenClaw, or Hermes, and no matter whether retrieval uses Vault, Hindsight, or Mem0, what she formally remembers is still the same life history.
