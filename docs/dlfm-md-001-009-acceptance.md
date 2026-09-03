# DLMF v0.1.1 — MD-001 through MD-009 Acceptance Ledger

**Date:** 2026-09-03  
**Baseline:** DLMF v0.1  
**Amendment:** Memory Distillation & Provider Boundary v0.1.1

## DLMF-MD-001 — Canonical Boundary Amendment

Implemented:

- Hermes operational transcript != Canonical Memory;
- Memory Distillation produces candidates, not canonical truth;
- DistillationReceipt semantics;
- zero-memory successful preservation;
- Hindsight distillation/projection plane separation;
- INV-9 and INV-10.

```ini
BOUNDARY_CONTRACT=PASS
```

## DLMF-MD-002 — MemoryDistillationProvider Contract

Implemented:

- provider-neutral `distill`, `recall`, `reflect`;
- provider output uses candidate drafts without canonical IDs;
- canonical commit API is not exposed to providers;
- Hindsight-specific types remain inside the Hindsight adapter module.

```ini
PROVIDER_CONTRACT=PASS
```

## DLMF-MD-003 — Candidate Epistemic Model

Implemented on candidates and canonical revisions:

- `epistemicStatus`;
- `confidence`;
- `producer`;
- `evidenceRefs`;
- `sourceExperienceRefs`;
- provider-independent semantic fingerprint;
- verifier integrity checks.

Reflective output cannot claim observed status.

```ini
EPISTEMIC_MODEL=PASS
```

## DLMF-MD-004 — Hindsight Adapter

`HindsightMemoryAdapter` maps:

```text
retain + document-scoped listMemories -> distill
recall                                -> MemoryEvidence
reflect                               -> DerivedMemoryCandidate draft
```

The adapter preserves Hindsight identifiers as evidence/provider references and
keeps the distillation and canonical projection banks distinct.

Mocked Hindsight contract tests are included, including a regression proving that a
long transcript is never used as a recall query and a pagination test for document
enumeration. A wire-level smoke test with the real Hindsight TypeScript client verifies
that the production path is `POST /memories` followed by
`GET /memories/list?...&document_id=...`, with no `/recall` request. The adapter's
`HindsightClientPort` remains the real-provider seam; no Hindsight credentials or
service are required by the default unit suite.

```ini
HINDSIGHT_ADAPTER=PASS
```

## DLMF-MD-005 — Distillation Receipt

Implemented:

- durable receipt contract;
- in-memory and PostgreSQL stores;
- pending -> ingested -> archived -> distilled -> canonicalized -> complete;
- failed state with stage/error details;
- retry attempts and scoped idempotency;
- zero canonical memory completion;
- no prune on provider failure.

```ini
DISTILLATION_RECEIPT=PASS
```

## DLMF-MD-006 — Raw Archive Contract

Implemented:

- `RawExperienceArchiveProvider`;
- first filesystem adapter;
- content checksum;
- resolvable archive reference;
- verification;
- no large transcript blob requirement in canonical PostgreSQL tables.

```ini
RAW_ARCHIVE_CONTRACT=PASS
```

## DLMF-MD-007 — Transcript Distillation E2E

Tested flow:

```text
Hermes transcript fixture
 -> filesystem raw archive
 -> Hindsight adapter
 -> MemoryCandidate
 -> DLMF governance
 -> CanonicalMemoryAuthority
 -> CanonicalMemory
 -> DistillationReceipt COMPLETE
```

Retry of an already completed source/policy/provider tuple does not invoke
Hindsight again.

```ini
TRANSCRIPT_DISTILLATION_E2E=PASS
```

## DLMF-MD-008 — Reflective Memory E2E

Tested flow:

```text
CanonicalMemory + evidence
 -> Hindsight reflect
 -> derived_insight_candidate
 -> epistemicStatus=synthesized
 -> PENDING candidate
```

No canonical change is emitted by the reflective service. A malicious provider
attempting `observed` reflective output is rejected at runtime.

```ini
REFLECTIVE_MEMORY_E2E=PASS
```

## DLMF-MD-009 — Prune Eligibility Contract

Implemented explainable `PruneEligibilityDecision`.

Acceptance behavior:

```text
no receipt                                -> false
failed receipt                            -> false
complete + archive durable + policy OK    -> true
complete + zero canonical memories        -> true when policy is satisfied
```

The service may persist eligibility to the receipt but contains no Hermes delete
operation.

Governed tombstones also suppress re-distillation resurrection.

```ini
PRUNE_ELIGIBILITY=PASS
```

## Final acceptance

Default automated suite validates the canonical contracts, mocked Hindsight seam,
filesystem archive, in-memory receipts, transcript E2E, reflective E2E, failure
model, idempotency, zero-memory completion, and forgetting guard.

The PostgreSQL integration gate additionally applies migration
`0003_memory_distillation.sql` and validates durable `DistillationReceipt`
round-trip when `DLFM_TEST_DATABASE_URL` is supplied.

```ini
BOUNDARY_CONTRACT=PASS
PROVIDER_CONTRACT=PASS
EPISTEMIC_MODEL=PASS
HINDSIGHT_ADAPTER=PASS
DISTILLATION_RECEIPT=PASS
RAW_ARCHIVE_CONTRACT=PASS
TRANSCRIPT_DISTILLATION_E2E=PASS
REFLECTIVE_MEMORY_E2E=PASS
PRUNE_ELIGIBILITY=PASS
DLMF_MEMORY_DISTILLATION_AMENDMENT=PASS
```

## Production constraint

This acceptance does **not** authorize automatic pruning or bulk migration of
Nancy's existing Hermes database. The next production step is a small, manually
reviewed session pilot before any bounded migration stage.
