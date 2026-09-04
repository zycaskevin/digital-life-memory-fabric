# DLMF-MD-010 — Canonical Admission & Memory Curation Gate

**Date:** 2026-09-04

**Status:** Implementation / acceptance baseline

**Applies to:** Digital Life Memory Fabric v0.1.1+

**Production pilot baseline:** `pilot_20260904140955`

## 1. Problem statement

The v0.1.1 Production Pilot proved that Hindsight can reliably ingest and extract long Hermes transcripts. The remaining blocker is admission precision: a high-recall extraction provider must not be treated as a canonical truth producer.

MD-010 inserts an explicit DLMF-owned curation and admission boundary:

```text
Raw Experience
  -> Hindsight Extraction
  -> Provider Memory Units
  -> Memory Curation Provider (proposal only)
  -> DLMF Deterministic Canonical Admission Policy
  -> MemoryCandidate (only when admitted)
  -> DLMF Governance
  -> CanonicalMemoryAuthority.commit()
  -> Canonical Memory
```

The provider, curator, and OmniHarness may supply memory intelligence. None of them owns canonical truth, canonical IDs, governance, or commit authority.

## 2. Architecture review decision

No blocking architecture issue was found. MD-010 is an authority-hardening milestone, not a new canonical authority.

The required boundary is:

- **Hindsight / MemoryDistillationProvider:** high-recall extraction. Emits `ProviderMemoryUnit` only.
- **MemoryCurationProvider:** replaceable cloud/local/OmniHarness-backed intelligence. Emits curation proposals only.
- **CanonicalAdmissionPolicy:** DLMF-owned deterministic gate. Converts proposals into one of the four governed outcomes.
- **Canonical admission reference:** DLMF attaches a versioned reference to admitted provider candidates, linking admission policy, curator, and curation record. The reference is not self-authenticating.
- **MemoryCandidateService:** receives only units admitted as `canonical_candidate`.
- **MemoryCandidateGovernance:** deterministic final policy check before commit.
- **CanonicalMemoryAuthority:** sole canonical commit authority and independently verifies provider-produced candidates against the DLMF-owned admitted curation record before commit.

Provider or curator availability, confidence, evidence count, or model reasoning never grants canonical authority.

## 3. Contract

Each provider unit has a stable provider-local reference plus explicit content, provenance, evidence, producer identity, and epistemic status.

Each curation proposal includes:

- `providerUnitRef`
- proposed outcome
- epistemic attribution and attribution basis
- `memoryWorthy`
- durability class
- semantic disposition
- reason codes
- optional target memory for duplicate/merge decisions
- optional curated candidate draft

The DLMF admission policy produces the final per-unit admission decision. The required outcomes are:

- `supporting_evidence_only`
- `rejected`
- `pending_review`
- `canonical_candidate`

A curation run must cover every provider unit exactly once. Missing, duplicate, or unknown unit references fail closed.

## 4. State model

```text
pending
  -> ingested
  -> archived
  -> distilled
  -> curated
  -> canonicalized
      -> complete
      -> awaiting_review

any execution stage -> failed
```

`awaiting_review` is intentionally not equivalent to success for retention or pruning. `complete` requires complete admission coverage and zero pending-review units.

A retry is idempotent for terminal `complete` and `awaiting_review` receipts under the same source, policies, provider, and curator identity/version.

## 5. Admission rules

A provider unit can become a canonical candidate only when all of the following hold:

1. Curation coverage is present and valid.
2. The curator marks it memory-worthy.
3. Durability is admissible for canonical memory.
4. Epistemic attribution passes deterministic grounding rules.
5. Semantic disposition does not require unresolved merge/review.
6. Any curator-proposed candidate rewrite is identical to the provider unit's baseline candidate semantics; otherwise review is required.
7. Exact canonical duplicate checks do not find an existing or tombstoned semantic fingerprint.
8. Existing deterministic `MemoryCandidateGovernance` accepts the resulting DLMF candidate.

Only then may `CanonicalMemoryAuthority.commit()` execute. The authority re-checks the boundary independently: `producer.kind=provider` requires a `canonicalAdmission` reference with `outcome=canonical_candidate`, and the configured DLMF admission verifier must find a matching admitted curation record for the same candidate, scope, source, provider run, content, epistemic attribution, durability, semantic disposition, policy, and curator. A caller-fabricated reference therefore does not grant authority. Provider-produced `inferred` / `synthesized` / `uncertain` candidates cannot auto-commit even if a caller attempts to fabricate such a reference.

## 6. Epistemic rules

Direct statuses are:

- `observed`
- `user_asserted`
- `system_observed`

Derived or uncertain statuses are:

- `inferred`
- `synthesized`
- `uncertain`

Derived/uncertain provider units never auto-admit as canonical candidates.

Evidence presence alone is not an epistemic upgrade. In particular, a `synthesized` or `inferred` provider unit cannot become `user_asserted` merely because a similar quote exists in the raw transcript.

`direct_source_quote` attribution is accepted automatically only for an already `user_asserted` provider unit whose quote is grounded in the raw source. Other attempted upgrades fail to `pending_review` / `uncertain`.

`EvidenceBoundMemoryGovernance` also rejects `inferred`, `synthesized`, and `uncertain` candidates as a defense-in-depth backstop.

## 7. Memory-worthiness and durability

Direct epistemic status is necessary but not sufficient for canonical admission.

Baseline durability classes:

- `transient`: ephemeral events or context; supporting evidence only.
- `session_scoped`: session-local state; supporting evidence only.
- `time_bounded`: commitments/project state that may expire or change; supporting evidence only in the conservative baseline.
- `durable`: stable preferences, relationships, habits, or explicitly classified durable content.
- `identity_long_term`: highest long-term durability class; must be explicitly proposed and still pass deterministic policy.
- `unknown`: fail closed to review.

The built-in conservative curator intentionally classifies generic facts as `unknown`. A richer cloud/local curator may improve classification, but its result remains a proposal subject to the same deterministic gate.

## 8. Dedup / merge semantics

Automatic semantic merge is deliberately narrow:

- Exact DLMF semantic fingerprint match -> `supporting_evidence_only`, linked to the existing canonical memory.
- Exact match to a tombstoned memory -> suppressed as governed forgetting; no resurrection commit.
- Curator-declared duplicate -> accepted only when the target canonical memory exists in the same scope; otherwise `pending_review`.
- `merge_required` / fuzzy semantic merge -> `pending_review`.

A model may propose a merge but cannot mutate or merge canonical memory directly. MD-010 does not introduce automatic fuzzy merge authority.

## 9. Curation provider boundary

`MemoryCurationProvider` is intentionally replaceable. Implementations may use:

- cloud models
- local models
- OmniHarness provider routing
- deterministic local heuristics

The provider may classify worthiness, durability, epistemic attribution, and semantic disposition. It may propose a curated candidate draft.

It cannot:

- assign canonical memory IDs
- write canonical memory
- override canonical governance
- silently upgrade epistemic status
- silently rewrite content into canonical truth
- execute forgetting or pruning
- mint or self-authenticate a canonical admission reference by itself

A materially rewritten curated candidate is routed to review rather than automatically committed.

## 10. Fail-closed behavior

The pipeline fails closed on:

- provider result contract violations
- duplicate provider unit references
- missing/duplicate/unknown curation proposals
- curation provider identity/version mismatch
- admission policy version mismatch
- ungrounded epistemic attribution
- invalid duplicate target
- semantic merge requirement
- curation audit-store failure before canonical commit
- canonical governance rejection
- direct provider-candidate commit attempts without a DLMF canonical admission reference
- syntactically valid admission references that are not backed by a matching DLMF curation record
- low-certainty provider candidates attempting to commit even with a fabricated reference

A pre-canonical curation audit record is persisted before a canonical write is attempted. If this audit write fails, no canonical commit is performed.

A later audit update failure after a canonical commit cannot be made atomically equivalent across arbitrary storage providers; the receipt becomes failed and remains non-prune-eligible. The pre-canonical decision record plus canonical candidate provenance provide reconciliation evidence. Production deployments should colocate canonical and curation PostgreSQL stores when possible.

## 11. Retention and Hermes prune interaction

`pruneEligible=true` now requires all of:

- receipt `status=complete`
- final canonicalization outcome
- matching retention policy version
- matching admission policy version
- raw archive ref + checksum recorded and verified
- curation coverage complete
- `curationDecisionCount == providerUnitCount`
- curation outcome total equals provider unit count
- `admissionComplete=true`
- zero `pending_review` units

Eligibility is revocable: refreshing a receipt can set `pruneEligible=false` again when policy conditions no longer hold.

**`AUTO_HERMES_PRUNE` remains FROZEN.** MD-010 does not delete Hermes data.

## 12. Auditability and receipts

`DistillationReceipt` now records aggregate admission evidence:

- provider unit count
- curation decision count
- all four outcome counts
- curation coverage completeness
- admission completeness
- curator identity/version
- admission policy version
- candidate IDs
- canonical memory IDs
- warnings/errors
- retention/prune decision state

`memory_curation_records` persists one auditable record per provider unit, including:

- raw provider unit text/fingerprint/reference
- provider epistemic status
- curator identity/version
- admission policy version
- attributed epistemic status
- worthiness and durability
- semantic disposition
- outcome and reason codes
- target memory, candidate, and canonical memory linkage where applicable

An admitted provider candidate also carries `canonicalAdmission`, and canonical provenance preserves the same reference fields: admission policy version, curation provider/version, curation record ID, and `canonical_candidate` outcome. Canonical authority treats these fields only as a lookup reference and verifies them against the DLMF-owned curation record before commit.

## 13. Migration impact

Migration `0004_canonical_admission.sql` is additive to canonical memory data.

Existing canonical memory/revisions are not rewritten or deleted.

Legacy v0.1.1 distillation receipts cannot prove MD-010 admission completeness, so migration marks them as `legacy_unreviewed`, clears curation/admission completeness, revokes `prune_eligible`, and preserves their data for audit/review.

No bulk re-curation or bulk migration is implied by the schema migration.

## 14. Acceptance criteria

MD-010 is implementation-complete only when automated tests prove at minimum:

- provider output remains non-canonical until admission
- `synthesized/inferred/uncertain` cannot auto-canonicalize
- evidence/quote presence cannot upgrade derived provider output into direct truth
- direct statuses still pass worthiness and durability filters
- incomplete curation coverage fails before candidate/canonical creation
- curator content rewrite cannot silently become canonical
- fuzzy/`merge_required` semantics require review
- exact semantic duplicates do not create duplicate canonical memories
- governed forgetting cannot be resurrected by re-distillation
- curation audit failure blocks canonical commit
- `pending_review` blocks admission completeness and pruning
- receipt/prune policy versions are coupled
- `CanonicalMemoryAuthority` rejects provider candidates lacking an admission reference, rejects syntactically valid direct-status forged references with no backing DLMF curation record, and rejects low-certainty provider candidates even with a fabricated reference
- PostgreSQL migration, receipt, candidate-admission-proof, and curation-record persistence round-trip
- long-transcript distillation continues using `retain(documentId) -> listMemories(documentId)` without recall-query regression

## 15. Production Pilot acceptance after MD-010

Do **not** rerun Production Pilot during implementation.

After MD-010 code/tests/docs are complete, rerun the exact pinned 5-session dataset used by the existing Production Pilot and record:

```text
provider memory units
  -> canonical_candidate outcomes (curated candidates)
  -> canonical memories
```

Also report the other three curation outcomes and perform human quality review for precision, recall, epistemic correctness, duplicate/merge quality, and durability classification.

The pilot must continue to report `HERMES_PRUNE_EXECUTED=false`.

Do not claim bulk migration readiness or automatic pruning readiness until the post-MD-010 Production Pilot and manual quality review pass.
