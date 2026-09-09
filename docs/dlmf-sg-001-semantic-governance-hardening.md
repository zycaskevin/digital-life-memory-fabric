# DLMF-SG-001 — Semantic Governance Hardening

**Date:** 2026-09-08
**Status:** Implemented; extended by DLMF-SG-002
**Baseline:** DLMF v0.1.1 Memory Distillation & Provider Boundary Amendment
**Base:** `origin/main@076e95bc06783b3739998dd37f86ecc2798d55b6`

The concurrency retry, multilingual policy v2, and explicit accepted-insight
promotion workflow are recorded in
`docs/dlmf-sg-002-concurrency-multilingual-promotion.md`.

## Objective

Close the semantic-quality findings from the five-session Production Pilot without
changing the v0.1.1 authority boundary. Hindsight remains a replaceable
`MemoryDistillationProvider` / Memory Intelligence Provider. DLMF remains the sole
authority for memory classification, semantic identity, canonical merge, reflective
insight governance, and canonical commit.

## Bounded change

This packet adds:

- DLMF-owned per-memory classification (`preference`, `technical_fact`,
  `transient_state`, `project_state`, and the existing durable classes);
- speaker provenance as data that is distinct from epistemic status;
- deterministic semantic identity plus audited equivalence/subsumption merge into
  one canonical memory identity;
- additive PostgreSQL persistence for semantic fields and reflective insights;
- a first-class `ReflectiveInsight` object and store;
- a fail-closed promotion gate whose default Hindsight result is `pending` and never
  invokes `CanonicalMemoryAuthority.commit()`;
- Production Pilot reporting and regression fixtures for the observed semantic
  quality failures.

This packet does not add a model dependency, authorize fuzzy model-driven merge,
run a Production Pilot Apply, unfreeze automatic Hermes pruning, rewrite legacy
canonical rows, or grant Hindsight canonical authority.

## Decision record

### DR-SG-001 — Semantic identity is DLMF-owned

Provider text and metadata are extraction evidence. A versioned DLMF semantic policy
reclassifies each provider unit and computes its semantic key before curation. A
provider-supplied key cannot authorize a merge.

The first policy is deliberately bounded and deterministic. It recognizes the known
pilot equivalence family for the Nancy inline-live-commentary preference and otherwise
falls back to a normalized content identity. A later learned semantic matcher may
propose relations, but promotion into an automatic rule requires a separate reviewed
packet.

### DR-SG-002 — Equivalence/subsumption merges evidence, not identity

When an admitted direct-memory unit has the same DLMF semantic key as an active
canonical revision, DLMF creates an audited `merge` revision on the existing memory.
The canonical content and memory ID remain stable while evidence and source-experience
provenance are unioned. A tombstoned match remains suppressed; it is never resurrected.

The merge candidate carries a DLMF-issued, curation-record-backed
`canonical_merge` proof. `CanonicalMemoryAuthority` rejects an unbacked or forged
merge proof.

### DR-SG-003 — Speaker provenance is not epistemic authority

`speakerProvenance=user` records where source text came from. It only permits
`user_asserted` for user-owned preference, habit, or relationship statements in the
bounded baseline. Technical facts, system findings, project state, and transient state
from a user-facing session are not upgraded solely because the speaker was the user.
Mixed-transcript and provider observations remain derived/uncertain unless a stronger
DLMF-owned basis exists.

Session category is selection metadata only and never determines `memoryType`.

### DR-SG-004 — Reflective insight is a separate truth domain

Reflection produces `ReflectiveInsight`, not `MemoryCandidate`. The object records
supporting/contradicting canonical memories, supporting evidence, confidence,
derivation provider/model/run, scope, status, and promotion eligibility. Missing
evidence closure keeps the insight ineligible. Even a closed insight requires an
explicit accepted governance state before it can become promotion-eligible.

The service has no canonical commit dependency or call. `canonicalWritePerformed` is
persisted as `false` and constrained false in PostgreSQL for this schema version.

## Executable acceptance

1. The five paraphrases from session `20260828_174230_77857c` resolve to one semantic
   key and one canonical memory ID; later paraphrases create merge revisions that
   accumulate evidence.
2. The floating-point diagnostic and security-review finding are not attributed as
   `user_asserted` merely because they came from user-facing text.
3. One `preference_change` session may yield `preference`, `technical_fact`,
   `transient_state`, and `project_state` memories.
4. The phase-leakage reflection is stored as a first-class `ReflectiveInsight` with
   status `pending`, explicit evidence-closure evaluation, and
   `canonicalWritePerformed=false`.
5. A synthesized insight without closure cannot pass the promotion gate.
6. A forged semantic merge proof cannot commit.
7. Governed tombstones still suppress re-distillation.
8. Migration 0005 is additive, backfills legacy rows conservatively, and creates the
   reflective-insight store without rewriting canonical content.
9. `npm run check` passes; PostgreSQL integration runs when its existing test URL is
   available and otherwise remains an explicit skip.

## Rollback

Code rollback stops new semantic merges and insight writes. Migration 0005 is additive;
its columns/tables may remain inert. Existing merge revisions are immutable canonical
history and must be reversed through a later governed canonical revision, never by
deleting rows.
