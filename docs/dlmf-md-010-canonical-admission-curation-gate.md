# DLMF-MD-010 — Canonical Admission & Memory Curation Gate

**Date:** 2026-09-04

**Status:** Implemented; role-aware admission recall validated in Production Pilot #2; fresh user-projection synchronous retain transport failure identified; async retain remediation local automated acceptance PASS; Production Pilot #3 pending

**Applies to:** Digital Life Memory Fabric v0.1.1+

**Production pilot baseline:** `pilot_20260904140955`

**First post-MD-010 pilot evidence:** `pilot_20260905050229` (failed safe; no Hermes deletion)

**Second post-MD-010 pilot evidence:** `pilot_20260906095623` (admission recall improved; three Hindsight retain transport failures; no Hermes deletion)

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
- **MemoryCandidateService:** receives only units admitted as `canonical_candidate` on the distillation path.
- **Canonical admission reference:** DLMF attaches a versioned reference to admitted provider candidates, linking admission policy, curator, and curation record. The reference is not self-authenticating.
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
- `unknown`: supporting evidence only in the conservative baseline; unknown durability never auto-admits.

The built-in conservative curator intentionally classifies generic facts as `unknown`. A richer cloud/local curator may improve classification, but its result remains a proposal subject to the same deterministic gate. Low-certainty (`inferred` / `synthesized` / `uncertain`) units also terminate as `supporting_evidence_only` unless a separate deterministic ambiguity requires review. This avoids turning high-recall provider output into an unbounded human-review queue while preserving the rule that such units cannot become canonical truth automatically.

## 8. Dedup / merge semantics

Automatic semantic merge is deliberately narrow:

- Active DLMF semantic-key equivalence/subsumption match -> an audited `canonical_merge` candidate targeting the existing memory.
- The merge revision preserves canonical ID/content and unions evidence/source provenance.
- A tombstoned semantic-key match -> suppressed as governed forgetting; no resurrection commit.
- Curator-declared duplicate requires a valid same-scope target; provider/model `merge_required` or fuzzy matching remains `pending_review`.

Only the DLMF-owned semantic policy may authorize this narrow merge. Its proof binds target, relation, policy version, and curation record; Canonical Memory Authority independently verifies it. A model/provider still cannot mutate or merge canonical memory directly.

## 9. Curation provider boundary

`MemoryCurationProvider` is intentionally replaceable. Implementations may use:

- cloud models
- local models
- OmniHarness provider routing
- deterministic local heuristics

The provider may classify worthiness, durability, epistemic attribution, and semantic disposition. It may propose a curated candidate draft.

It cannot:

- mint or self-authenticate a canonical admission reference by itself
- assign canonical memory IDs
- write canonical memory
- override canonical governance
- silently upgrade epistemic status
- silently rewrite content into canonical truth
- execute forgetting or pruning

A materially rewritten curated candidate is routed to review rather than automatically committed.

## 10. Fail-closed behavior

The pipeline fails closed on:

- direct provider-candidate commit attempts without a DLMF canonical admission reference
- syntactically valid admission references that are not backed by a matching DLMF curation record
- low-certainty provider candidates attempting to commit even with a fabricated reference
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

A pre-canonical curation audit record is persisted **before provider candidate creation**, then linked to the concrete candidate before governance/commit. If either audit persistence or linkage fails, no provider-produced candidate can satisfy canonical authority verification and no canonical commit is performed.

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
- all five outcome counts, including `canonical_merge`
- curation coverage completeness
- admission completeness
- curator identity/version
- admission policy version
- candidate IDs
- canonical memory IDs
- warnings/errors
- retention/prune decision state

An admitted provider candidate also carries `canonicalAdmission`, and canonical provenance preserves the same reference fields: admission policy version, curation provider/version, curation record ID, and either `canonical_candidate` create or DLMF-issued `canonical_merge` outcome. Canonical authority treats these fields only as a lookup reference and verifies them against the DLMF-owned curation record before commit.

`memory_curation_records` persists one auditable record per provider unit, including:

- raw provider unit text/fingerprint/reference
- provider epistemic status and distinct DLMF-attributed status/basis
- per-memory type, speaker provenance, semantic key/policy/relation
- curator identity/version
- admission policy version
- attributed epistemic status
- worthiness and durability
- semantic disposition
- outcome and reason codes
- target memory, candidate, and canonical memory linkage where applicable

## 13. Migration impact

Migration `0004_canonical_admission.sql` is additive to canonical memory data. It adds nullable `memory_candidates.canonical_admission` for MD-010 proof persistence and validates its structural shape when present.

Migration `0005_semantic_governance.sql` additively backfills conservative semantic metadata, admits the bound `canonical_merge` proof shape, adds per-scope semantic-key uniqueness, and creates `reflective_insights` plus DLMF-owned `insight_promotion_records`. The reflective object itself is database-constrained to `canonical_write_performed=false`; an explicitly approved promotion is separately audited and must still pass through `MemoryCandidateService` and `CanonicalMemoryAuthority`.

Existing canonical memory/revisions are not rewritten or deleted.

Legacy v0.1.1 distillation receipts cannot prove MD-010 admission completeness, so migration marks them as `legacy_unreviewed`, clears curation/admission completeness, revokes `prune_eligible`, and preserves their data for audit/review.

No bulk re-curation or bulk migration is implied by the schema migration.

## 14. Acceptance criteria

MD-010 is implementation-complete only when automated tests prove at minimum:

- provider output remains non-canonical until admission
- `CanonicalMemoryAuthority` rejects provider candidates lacking an admission reference, rejects syntactically valid direct-status forged references with no backing DLMF curation record, and rejects low-certainty provider candidates even with a fabricated reference
- `synthesized/inferred/uncertain` cannot auto-canonicalize
- evidence/quote presence cannot upgrade derived provider output into direct truth
- direct statuses still pass worthiness and durability filters
- incomplete curation coverage fails before candidate/canonical creation
- curator content rewrite cannot silently become canonical
- fuzzy/`merge_required` semantics require review
- semantic equivalence/subsumption does not create duplicate canonical identities and instead records evidence-union merge revisions
- governed forgetting cannot be resurrected by re-distillation
- curation audit failure blocks canonical commit
- `pending_review` blocks admission completeness and pruning
- receipt/prune policy versions are coupled
- PostgreSQL migration, receipt, and curation-record persistence round-trip
- long-transcript distillation continues using `retain(documentId) -> listMemories(documentId)` without recall-query regression

## 15. Production Pilot evidence and admission-recall remediation

MD-010 implementation was completed without rerunning the Production Pilot. The first post-implementation Apply then reused the exact reviewed five-session manifest `pilot_20260903061930` and produced run `pilot_20260905050229`.

The run failed safe:

```text
provider_units=667
curated_candidates=0
canonical_memories=0
curation_supporting_evidence_only=0
curation_rejected=0
curation_pending_review=667
curation_canonical_candidate=0
PRODUCTION_PILOT=FAIL
AUTO_HERMES_PRUNE=FROZEN
HERMES_PRUNE_EXECUTED=false
```

All five receipts ended `awaiting_review/pending_review`, Reflection was skipped, and every source remained non-prune-eligible. This is valid production evidence: MD-010 successfully prevented the prior precision failure from becoming `667 -> 667` canonical memories, but the conservative gate over-corrected to `667 -> 0`. The blocker is classified as **Canonical Admission Recall Failure / Epistemic Attribution Coverage Failure**.

The root cause was deterministic and reproducible:

1. The mixed Hermes transcript was retained as one Hindsight document.
2. Hindsight source facts from that document did not carry DLMF source-role epistemic metadata.
3. The adapter therefore correctly defaulted them to `synthesized` rather than inventing a direct attribution.
4. The original conservative curator escalated every synthesized or unknown-durability unit to `pending_review`.
5. Consequently, complete extraction coverage became a 667-item review queue with zero admissible candidates.

The remediation preserves the strict canonical boundary rather than weakening it:

- The original full transcript still uses the proven `retain(full transcript, documentId) -> listMemories(documentId)` path for high recall. Units from this mixed-source projection remain `synthesized` unless independently grounded.
- The distillation request may now carry role-aware `sourceSegments` derived from the raw Hermes records. These segments are execution provenance only; the raw archive remains evidence authority.
- The adapter creates a second **user-only source projection** containing only original `role=user` message content. Hindsight `world` facts from this isolated projection may carry `user_asserted` provenance.
- Hindsight `observation` units are always mapped back to `synthesized`, even if produced from a user-only projection, because observations are consolidation outputs rather than raw source facts.
- `inferred`, `synthesized`, `uncertain`, and unknown-durability facts now terminate as `supporting_evidence_only` in the conservative baseline instead of automatically requiring human review.
- `pending_review` remains reserved for genuine unresolved admission ambiguity such as material curator rewrites, fuzzy/required merges, invalid duplicate targets, or ungrounded epistemic upgrades.
- `DeterministicCanonicalAdmissionPolicy` and `CanonicalMemoryAuthority` verification rules are unchanged. A provider or curator still cannot self-authorize canonical truth.

The remediation changes execution identity so old receipts cannot be reused accidentally:

```text
distillationPolicyVersion = pilot-distill-v2-role-aware
curationProviderVersion    = pilot-curation-v2-role-aware
adapterVersion             = hindsight-production-pilot-v0.1.1-role-aware-v2
admissionPolicyVersion     = pilot-admission-v1   # unchanged deterministic authority
```

Local automated acceptance after the first role-aware remediation: **63 pass, 0 fail, 1 PostgreSQL runtime integration skip** in the CatDesk environment. The regression test proves that mixed-transcript facts remain synthesized, a user-only `world` preference can become a `user_asserted` canonical candidate, and a user-projection `observation` still remains synthesized/supporting evidence.

The second Production Pilot reused the same pinned manifest and produced `pilot_20260906095623`. Admission behavior improved materially:

```text
provider_units=83
curated_candidates=1
canonical_memories=1
curation_supporting_evidence_only=82
curation_pending_review=0
curation_canonical_candidate=1
AUTO_HERMES_PRUNE=FROZEN
HERMES_PRUNE_EXECUTED=false
PRODUCTION_PILOT=FAIL
```

Two sessions completed admission (`inferred_insight`: 80 units, 1 canonical; `ordinary_conversation`: 3 units, no memory-worthy content). Three longer sessions failed before provider-unit enumeration with the same provider error: `retainBatch failed: "fetch failed"`. The run inspector classified the preserved receipts as provider-stage failures; PostgreSQL admission state and pruning safeguards remained intact. `PILOT_RUN_INSPECT=PASS` means the failed run is auditable, not that Production Pilot acceptance passed.

The failure is isolated to the newly introduced fresh user-only Hindsight projection. The full mixed transcript path had already been exercised by prior runs, while the user-only document requires fresh extraction. Holding that extraction on a synchronous `async=false` HTTP request exposed a provider transport failure on longer sessions.

The second remediation keeps Hindsight's native chunking and changes only the user-role projection execution mode:

- submit the user-only projection with `async=true`;
- use a deterministic client-supplied Hindsight `operation_id`, derived from source checksum, policy, document identity, and projection content, so a retry cannot enqueue duplicate work;
- poll the provider operation with bounded requests until explicit `completed`;
- fail closed on `failed`, `cancelled`, `not_found`, malformed status, status transport failure, or polling timeout;
- enumerate document-scoped provider memory units only after provider completion;
- leave full-source extraction, epistemic attribution, curation, deterministic admission, governance, and canonical authority unchanged.

Execution identity is advanced again:

```text
distillationPolicyVersion = pilot-distill-v3-role-aware-async
curationProviderVersion    = pilot-curation-v2-role-aware
adapterVersion             = hindsight-production-pilot-v0.1.1-role-aware-async-v3
admissionPolicyVersion     = pilot-admission-v1
```

Local automated acceptance after async remediation: **85 pass, 0 fail, 1 PostgreSQL runtime integration skip**. Tests cover successful async role projection, deterministic operation tracking, fail-closed provider operation failure, long-transcript no-recall behavior, and all MD-010 authority invariants.

The next Production Pilot rerun must use the same pinned five-session manifest and report:

```text
provider memory units
  -> supporting_evidence_only / rejected / pending_review / canonical_candidate
  -> canonical memories
```

Because the role-aware remediation intentionally adds a second user-only Hindsight document per session, the next `provider_units` total may be greater than 667. That total is therefore not a direct extraction-count regression metric. Acceptance is based on admission outcome distribution plus human review of precision, recall, epistemic correctness, duplicate/merge quality, and durability classification.

The pilot must continue to report `AUTO_HERMES_PRUNE=FROZEN` and `HERMES_PRUNE_EXECUTED=false`.

Do not claim bulk migration readiness or automatic pruning readiness until the remediated Production Pilot and manual quality review pass.
