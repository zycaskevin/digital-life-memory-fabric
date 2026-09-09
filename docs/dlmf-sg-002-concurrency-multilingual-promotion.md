# DLMF-SG-002 — Concurrency, Multilingual Semantics, and Insight Promotion

**Date:** 2026-09-09
**Status:** Implemented and locally verified
**Baseline:** DLMF v0.1.1 Memory Distillation & Provider Boundary Amendment
**Predecessor:** DLMF-SG-001

## Authority invariant

Hindsight remains a replaceable `MemoryDistillationProvider` / Memory Intelligence
Provider. It may extract or derive evidence, but it never chooses canonical identity,
accepts an insight, constructs an authoritative merge proof, or commits Canonical
Memory. DLMF owns those operations.

## Decisions

### DR-SG-005 — Semantic create collisions retry as governed merge

The scope/semantic-key unique index remains the final fail-closed guard. When two
independent processes both classify a new provider unit before either sees a head,
the create loser is marked `CONFLICT`, reloads the winning current revision, reruns
the DLMF semantic relation, and creates a new audited merge candidate. Retry is
bounded to four attempts. Contradiction, unrelated content, a disappeared target, or
a tombstone never auto-merges.

The PostgreSQL curation record upsert advances `semantic_relation` during this retry;
otherwise the Canonical Authority would correctly reject the stale merge proof.

### DR-SG-006 — Semantic policy v2 is multilingual and polarity-aware

The deterministic policy recognizes reviewed English and Traditional Chinese concept
aliases for the Nancy inline-commentary preference, dark mode, and notification
preferences. Same-concept opposite polarity is `contradicts` and requires review.
For recognized same-polarity concepts, normalized token subsets provide general
`existing_subsumes_candidate` / `candidate_subsumes_existing` evidence. Unknown
concepts remain normalized exact identity; no fuzzy model score can authorize merge.

### DR-SG-007 — Accepted insight promotion is a separate audited workflow

Reflection still writes only a pending `ReflectiveInsight` with
`canonicalWritePerformed=false`. An explicit reviewer invokes the DLMF-owned promotion
service with a scoped idempotency key and a required approval-verifier port. The
service requires confidence at least 0.75,
no unresolved contradictions, current active supporting memories, and evidence IDs
that close against those current canonical revisions.

Eligible promotion creates a runtime-owned `derived_insight_candidate` and calls the
existing `CanonicalMemoryAuthority`. It never relabels `synthesized`, `inferred`, or
`uncertain` as observed truth. `insight_promotion_records` stores approval, eligibility,
candidate, and canonical linkage independently from provider state.

### DR-SG-008 — Production remains manual-review-first

This packet authorizes disposable local PostgreSQL validation and read-only Production
Pilot preflight. It does not authorize Production Pilot Apply or Hermes pruning.
Production Apply requires a separately reviewed manifest and explicit owner approval;
automatic pruning remains frozen.

## Executable acceptance

1. Migrations 0001–0005 apply in a fresh disposable PostgreSQL schema.
2. Two actual Node processes released after both observe no semantic head yield one
   create, one collision retry merge, one canonical head at revision 2, two accepted
   candidates, and one conflict candidate.
3. English/Traditional Chinese aliases merge only within reviewed concept families;
   opposite polarity is pending review.
4. Explicit insight promotion is idempotent and persists its audit record; missing
   evidence closure, low confidence, and unresolved contradiction fail closed.
5. A successful promotion retains the insight's derived epistemic status and leaves
   `ReflectiveInsight.canonicalWritePerformed=false`.
6. Full repository typecheck, tests (including both PostgreSQL integrations), and build
   pass against the disposable database.

## Known limits

- The multilingual lexicon is deterministic and intentionally small; it is not a
  general natural-language inference engine.
- Token-subset subsumption applies only after a reviewed concept key matches.
- Retry is bounded rather than lock-based; sustained contention fails closed after
  four attempts and requires review.
- Insight acceptance is an application-service contract, not a user-interface or
  organizational approval system.

## Verification record

On 2026-09-09, `npm run check` ran against an isolated PostgreSQL 16 container
using a tmpfs data directory. Migrations 0001–0005 applied in fresh schemas and the
suite reported `102 pass / 0 fail / 0 skip` on the current main baseline; typecheck and build also passed. The
container was then stopped and auto-removed.

The read-only Production Pilot preflight passed after binding the isolated worktree
to the verified OmniHarness Hindsight client location. Production Apply was not run,
and automatic Hermes pruning remains frozen pending explicit authorization and manual
review.
