# Digital Life Memory Fabric v0.1.1

## Memory Distillation & Provider Boundary Amendment

**Date:** 2026-09-03  
**Status:** Implemented Canonical Amendment  
**Baseline:** Digital Life Memory Fabric v0.1 — Canonical Memory Model  
**Scope:** DLMF only  
**First provider:** Hindsight  
**Implementation:** DLMF-MD-001 through DLMF-MD-009

---

## 1. Executive decision

Digital Life Memory Fabric remains authoritative for:

> **What a Digital Life officially remembers.**

Hindsight is a `MemoryDistillationProvider` / Memory Intelligence Provider. It may
extract, retrieve, and reflect. It does not assign canonical memory identity,
declare canonical truth, resolve contradictions authoritatively, forget canonical
memory, or decide operational transcript deletion.

The implemented boundary is:

```text
Hermes state.db
  Operational Transcript Store
          |
          v
RawExperienceArchiveProvider
  durable raw evidence
          |
          v
MemoryDistillationProvider
  Hindsight: distill / recall / reflect
          |
          v
MemoryCandidate
          |
          v
DLMF governance / canonical authority
          |
          +----> CanonicalMemory
          |
          +----> DistillationReceipt
                    |
                    v
             PruneEligibilityDecision
                    |
                    v
          external Hermes maintenance owner
```

DLMF contains no Hermes SQLite delete/prune implementation.

---

## 2. Canonical responsibility model

| Layer | Owns | Does not own |
|---|---|---|
| Hermes | active/recent transcript and runtime session state | lifetime canonical memory |
| Raw archive | durable raw transcript/event bytes | semantic truth |
| Hindsight | extraction, provider recall, reflection | canonical IDs or canonical truth |
| DLMF | candidate identity, epistemic status, evidence, provenance, governance, canonical commit, forgetting, retention eligibility | Hermes DB maintenance |

`Raw Experience`, provider memory, `MemoryCandidate`, and `CanonicalMemory` are
separate artifacts.

---

## 3. MemoryDistillationProvider contract

The provider-neutral contract is defined in
`src/distillation/memory-distillation-provider.ts`:

```ts
interface MemoryDistillationProvider {
  readonly name: string;
  readonly adapterVersion: string;
  readonly providerVersion: string | undefined;

  distill(request: DistillationRequest): Promise<DistillationResult>;
  recall(request: RecallRequest): Promise<MemoryEvidence[]>;
  reflect(request: ReflectRequest): Promise<ReflectResult>;
}
```

Provider results contain candidate drafts. They deliberately contain no
`candidateId`, `memoryId`, canonical revision, or canonical commit function.
Only DLMF creates those identifiers and commits canonical state.

---

## 4. Hindsight adapter and two-plane rule

`HindsightMemoryAdapter` implements the first provider.

The adapter requires two distinct logical banks/namespaces:

```text
Hindsight Distillation Plane
  raw-experience-derived working memory

Hindsight Canonical Projection Plane
  rebuildable projection of DLMF canonical memory
```

The adapter fails closed if the two bank IDs are equal.

### `distill()`

1. Retains the archived source experience into the **distillation plane**.
2. Recalls extraction results from that plane.
3. Accepts only results whose Hindsight `document_id` matches the current source
   experience.
4. Maps them into provider-neutral candidate drafts.
5. Preserves Hindsight IDs as evidence/provider references, never canonical IDs.

### `recall()`

Uses the **canonical projection plane** and returns `MemoryEvidence`, not canonical
content authority.

### `reflect()`

Uses canonical memory/evidence as context through the **canonical projection
plane** and returns only `derived_insight_candidate` drafts.

Provider-specific source/run IDs are not embedded in canonical semantic content.
They remain in evidence/provenance/run metadata.

---

## 5. Epistemic model

Every new `MemoryCandidate` and `MemoryRevision` carries:

```text
epistemicStatus
producer
sourceExperienceRefs[]
candidateFingerprint / semanticFingerprint
```

Supported epistemic statuses:

```text
observed
user_asserted
system_observed
inferred
synthesized
uncertain
```

Reflective output is restricted to:

```text
inferred | synthesized | uncertain
```

`ReflectiveMemoryService` performs a runtime fail-closed validation even if a
malicious or malformed provider bypasses compile-time typing and attempts to
return an observed reflective fact.

`CanonicalVerifier` verifies that canonical revision producer/source provenance
matches the provenance envelope and that its semantic fingerprint is present and
consistent.

---

## 6. Provider-independent semantic fingerprint

DLMF computes a provider-independent semantic fingerprint from:

```text
scope
candidate type
memory class
memory kind
semantic text
epistemic status
temporal semantics
```

Provider IDs and provider-specific payload metadata are excluded.

This supports:

- cross-provider duplicate suppression;
- re-distillation under a new provider;
- governed tombstone/forget suppression;
- provider replacement without changing canonical identity.

A provider can change `hs_fact_123` to another internal ID and still refer to the
same canonical semantics.

---

## 7. Transcript distillation lifecycle

`TranscriptDistillationService` implements:

```text
Hermes transcript
      |
      v
receipt: ingested
      |
      v
RawExperienceArchiveProvider.archive()
      |
      v
receipt: archived
      |
      v
MemoryDistillationProvider.distill()
      |
      v
receipt: distilled
      |
      v
MemoryCandidateService.ingest()
      |
      v
governance
      |
      +---- reject / suppress duplicate / suppress forgotten
      |
      +---- CanonicalMemoryAuthority.commit()
      |
      v
receipt: canonicalized
      |
      v
receipt: complete
```

The transcript service never calls a Hermes deletion API.

---

## 8. DistillationReceipt

Receipt persistence is provider-neutral. Implementations:

- `InMemoryDistillationReceiptStore` for deterministic tests/development;
- `PostgresDistillationReceiptStore` for durable canonical operations.

The PostgreSQL schema is in `migrations/0003_memory_distillation.sql`.

Important receipt states:

```text
pending
ingested
archived
distilled
canonicalized
complete
failed
```

Canonicalization outcome is separate from run status:

```text
pending
committed
no_memory_worthy_content
rejected
superseded
```

### Zero-memory success

A receipt may be `complete` with zero canonical memory IDs.

This is required because successful preservation does not imply that a
conversation contains anything worth remembering permanently.

---

## 9. Failure and retry model

The distillation idempotency key includes:

```text
scope
source experience ID
distillation policy version
provider name
```

A completed receipt makes an identical retry a no-op.

Provider failure behaves as follows:

```text
raw archive remains durable
canonical state remains unchanged
receipt = failed
prune eligibility = false
retry is allowed
```

Malformed provider output is validated before provider candidates are admitted
into canonical governance.

Partial canonicalization remains resumable because canonical semantic
fingerprints suppress duplicate re-commit.

---

## 10. Raw archive boundary

`RawExperienceArchiveProvider` owns raw byte/document persistence behind a
provider-neutral contract.

The first viable implementation is `FilesystemRawExperienceArchiveProvider`:

- content-addressed path;
- SHA-256 checksum;
- archive reference;
- restrictive file mode on creation;
- path traversal guard;
- checksum verification.

Canonical DLMF tables need only archive identity/provenance/checksum; they do not
need to become a transcript blob store.

Future archive providers may target R2, PostgreSQL, Google Drive, object storage,
or another archival system without changing canonical memory semantics.

---

## 11. Reflective distillation

`ReflectiveMemoryService` implements L3 reflective distillation:

```text
Canonical Memory + Evidence
        |
        v
Hindsight reflect
        |
        v
DerivedMemoryCandidate
  epistemic = inferred/synthesized/uncertain
        |
        v
PENDING
```

There is deliberately no `CanonicalMemoryAuthority.commit()` call in this
service. A later explicit governance decision is required for canonical commit.

---

## 12. Governed forgetting and resurrection guard

Canonical forgetting remains a DLMF governance operation represented by the
existing tombstone lifecycle.

When a tombstone is committed, the canonical revision preserves the semantic
fingerprint of the forgotten memory. Re-distillation checks current canonical
semantics before admitting a new candidate.

If the same semantics are found in a tombstoned current revision:

```text
candidate suppressed
warning = suppressed_by_governed_forget:<fingerprint>
no new canonical commit
```

Deleting Hindsight state alone is not canonical forgetting, and raw archive
re-distillation cannot silently resurrect a governed tombstone.

---

## 13. Prune eligibility

`PruneEligibilityService` returns an explainable `PruneEligibilityDecision`:

```text
eligible
receiptId
archiveVerified
retentionPolicyVersion
canonicalizationOutcome
blockingReasons[]
```

The initial `PreservationCompleteRetentionPolicy` requires:

- complete distillation receipt;
- explicit non-pending canonicalization outcome;
- durable archive reference/checksum;
- successful archive verification;
- matching retention policy version.

It does **not** require one or more canonical memories.

`refresh()` may persist the eligibility decision onto the receipt, but it still
does not delete Hermes data.

---

## 14. Canonical invariants

### INV-1
`Provider Memory != Canonical Memory`

### INV-2
Canonical Memory survives provider replacement.

### INV-3
Raw transcript is not permanent operational hot state.

### INV-4
Reflective inference is not an observed fact.

### INV-5
No transcript becomes prune-eligible before governed preservation.

### INV-6
Provider failure cannot erase memory.

### INV-7
Every Canonical Memory remains traceable to evidence/provenance.

### INV-8
DLMF does not own Hermes operational database maintenance.

### INV-9
Successful preservation does not require a Canonical Memory commit. A source may
be prune-eligible after durable archive, governed distillation, an explicit
zero-memory/rejected/superseded outcome, and retention-policy satisfaction.

### INV-10
Provider-derived working memory and provider projections of Canonical Memory must
remain logically distinguishable and rebuildable.

---

## 15. Explicit non-goals preserved

DLMF v0.1.1 does not implement:

- Hermes SQLite/WAL management;
- Hermes session deletion;
- Feishu or messaging transport;
- LLM orchestration;
- Life Runtime Concern state;
- Agent Factory workflow;
- Hindsight internal indexes;
- generic object storage infrastructure;
- transcript UI;
- Nancy's ~997k-message bulk migration.

Bulk migration remains a later consumer operation after quality validation on a
small session sample.

---

## 16. Amendment acceptance

The implementation is accepted by the repository test suite and the MD acceptance
ledger in `docs/dlfm-md-001-009-acceptance.md`.

Final contract target:

```ini
DLMF_MEMORY_DISTILLATION_AMENDMENT=PASS
```
