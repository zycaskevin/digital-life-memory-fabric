# Digital Life Memory Fabric v0.1.1

## Memory Distillation & Provider Boundary Amendment

**Date:** 2026-09-03  
**Status:** Implemented Canonical Amendment  
**Baseline:** Digital Life Memory Fabric v0.1 — Canonical Memory Model  
**Scope:** DLMF only  
**First provider:** Hindsight  
**Implementation:** DLMF-MD-001 through DLMF-MD-010

---

> **MD-010 admission amendment — 2026-09-04:** Hindsight distillation output is now explicitly `ProviderMemoryUnit`, not a DLMF `MemoryCandidate`. Every provider unit must pass a replaceable curation-proposal seam and DLMF-owned deterministic canonical admission policy before candidate creation. Derived/uncertain epistemic states cannot auto-canonicalize, and prune eligibility requires complete admission. See `docs/dlmf-md-010-canonical-admission-curation-gate.md`.
>
> **Semantic Governance Hardening — 2026-09-08:** DLMF now owns per-memory classification, speaker-versus-epistemic attribution, deterministic semantic identity, audited equivalence/subsumption evidence merge, and first-class reflective-insight promotion eligibility. This does not grant Hindsight or a curator canonical authority. See `docs/dlmf-sg-001-semantic-governance-hardening.md`.

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
ProviderMemoryUnit
          |
          v
MemoryCurationProvider
  proposal only
          |
          v
DLMF CanonicalAdmissionPolicy
          |
          +---- supporting_evidence_only / rejected / pending_review
          |
          +---- canonical_candidate -> MemoryCandidate
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
| Curation provider | worthiness/durability/epistemic/semantic proposals | canonical admission or commit authority |
| DLMF | deterministic admission, candidate identity, epistemic attribution, evidence, provenance, governance, canonical commit, forgetting, retention eligibility | Hermes DB maintenance |

`Raw Experience`, `ProviderMemoryUnit`, curation proposal, admitted `MemoryCandidate`,
and `CanonicalMemory` are separate artifacts. Provider-produced candidates that reach
canonical authority must carry a DLMF-issued `canonicalAdmission` reference tying them to
the admission policy, curation provider, and curation audit record. The reference is not
self-authenticating: canonical authority verifies it against the DLMF-owned admitted
curation record before commit.

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

Distillation results contain `ProviderMemoryUnit` values. They deliberately contain no
`candidateId`, `memoryId`, canonical revision, or canonical commit function. A provider
unit is extraction evidence, not a DLMF candidate. MD-010 requires curation and
deterministic admission before DLMF may create a `MemoryCandidate`; only DLMF creates
canonical identifiers and commits canonical state.

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
2. Enumerates the resulting Hindsight memory units with a **document-scoped**
   `listMemories(documentId=...)` call. Distillation never sends the raw transcript
   as a natural-language recall query.
3. Requires every returned unit to carry the exact current Hindsight `document_id`;
   a mismatch fails closed.
4. Paginates the document enumeration with explicit bounds before mapping provider
   units into candidate drafts.
5. Preserves Hindsight IDs as evidence/provider references, never canonical IDs.

This distinction is intentional: Hindsight `recall()` is a natural-language retrieval
API with a bounded query length and is reserved for runtime evidence retrieval from the
canonical projection plane. Distillation uses document identity, not semantic search.

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
memoryType                 # per-memory; never inherited from session category
speakerProvenance          # source speaker, not truth authority
epistemicStatus            # DLMF attribution
semanticKey                # versioned DLMF semantic identity
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

## 6. DLMF semantic key and provider-independent fingerprint

DLMF first computes a versioned semantic key from per-memory content/type. The bounded v1 policy recognizes the known Nancy inline-live-commentary preference family; other content falls back to normalized exact semantic identity. Active key matches may create an audited evidence-only merge revision; a tombstoned match remains suppressed.

DLMF also computes a provider-independent candidate/revision fingerprint from:

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
ProviderMemoryUnit[] / receipt: distilled
      |
      v
MemoryCurationProvider.curate()  (proposal only)
      |
      v
receipt: curated
      |
      v
DLMF CanonicalAdmissionPolicy
      |
      +---- supporting_evidence_only / rejected / pending_review
      |
      +---- canonical_candidate -> MemoryCandidateService.ingest()
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
      +---- awaiting_review (any unresolved unit)
      |
      +---- complete (full admission coverage, zero pending_review)
```

The transcript service never calls a Hermes deletion API.

---

## 8. DistillationReceipt

Receipt persistence is provider-neutral. Implementations:

- `InMemoryDistillationReceiptStore` for deterministic tests/development;
- `PostgresDistillationReceiptStore` for durable canonical operations.

The base receipt schema is in `migrations/0003_memory_distillation.sql`; MD-010 admission/audit fields and `memory_curation_records` are added by `migrations/0004_canonical_admission.sql`. Additive semantic fields, canonical-merge proof shape, per-scope semantic-key uniqueness, five-outcome receipts, `reflective_insights`, and DLMF-owned `insight_promotion_records` are added by `migrations/0005_semantic_governance.sql`.

Important receipt states:

```text
pending
ingested
archived
distilled
curated
canonicalized
awaiting_review
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
pending_review
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
canonicalization policy version
provider name
curation provider name/version
admission policy version
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

Malformed provider output and incomplete/malformed curation coverage are validated
before any provider unit can become a DLMF candidate. Derived/uncertain epistemic units
fail closed to review instead of entering canonical governance automatically.

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
provider-derived insight draft
  epistemic = inferred/synthesized/uncertain
        |
        v
ReflectiveInsight
  supportingMemoryIds / supportingEvidenceIds
  contradictingMemoryIds / confidence
  derivationProvider / derivationModel / derivationRunId
  status = pending
  canonicalWritePerformed = false
```

There is deliberately no `CanonicalMemoryAuthority.commit()` call in this
service. `ReflectiveInsightPromotionGate` requires evidence closure, no unresolved
contradictions, minimum confidence, and explicit accepted status before promotion
eligibility. The gate does not itself perform a canonical write.

`ReflectiveInsightPromotionService` is a separate DLMF-owned, explicitly invoked
workflow. It revalidates current in-scope supporting canonical revisions and their
evidence closure, records the reviewer and idempotency key, creates a runtime-owned
candidate, and delegates the commit to `CanonicalMemoryAuthority`. Hindsight remains
derivation provenance only. The original insight remains
`canonicalWritePerformed=false`, including after a successful promotion.

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
admissionPolicyVersion
canonicalizationOutcome
curationCoverageComplete
admissionComplete
blockingReasons[]
```

The MD-010 `PreservationCompleteRetentionPolicy` requires:

- complete distillation receipt;
- explicit final canonicalization outcome;
- durable archive reference/checksum and successful archive verification;
- matching retention policy version;
- matching admission policy version;
- complete curation coverage;
- curation decision/outcome counts matching every provider unit;
- `admissionComplete=true`;
- zero `pending_review` units.

It does **not** require one or more canonical memories: a fully curated source may
legitimately resolve to evidence-only/rejected/zero-memory outcomes.

Eligibility is revocable. `refresh()` may set `pruneEligible=false` again whenever
current policy/admission conditions no longer hold. It still does not delete Hermes data.

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
be prune-eligible after durable archive, governed distillation, complete MD-010
curation/admission, an explicit final evidence-only/zero-memory/rejected/superseded
outcome, and current retention/admission-policy satisfaction.

### INV-10
Provider-derived working memory and provider projections of Canonical Memory must
remain logically distinguishable and rebuildable.

### INV-11
Provider output and curation-provider output are never canonical truth. Curation may
propose; DLMF deterministic admission/governance retains final authority. Canonical
authority independently rejects provider candidates without a matching DLMF-owned
admitted curation record, treats `canonicalAdmission` only as a lookup reference, and
rejects provider-derived `inferred`/`synthesized`/`uncertain` candidates from automatic
commit even if a caller fabricates such a reference.

### INV-12
`AUTO_HERMES_PRUNE` remains frozen until post-MD-010 Production Pilot quality review
passes. `pruneEligible` is an auditable decision, not a delete command.

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

MD-001 through MD-009 remain recorded in `docs/dlfm-md-001-009-acceptance.md`.
MD-010 supersedes the old direct-admission/prune semantics and is specified in
`docs/dlmf-md-010-canonical-admission-curation-gate.md`.

Final contract target:

```ini
DLMF_MEMORY_DISTILLATION_AMENDMENT=PASS
```
