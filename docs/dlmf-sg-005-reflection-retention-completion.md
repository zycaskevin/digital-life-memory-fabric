# DLMF-SG-005 — Reflection and Retention Completion

**Date:** 2026-09-09
**Status:** Implemented; full validation, independent review, and production acceptance pending
**Baseline:** DLMF v0.1.1 Memory Distillation & Provider Boundary Amendment
**Predecessor:** DLMF-SG-004

## Authority invariant

Hindsight remains a `MemoryDistillationProvider` / Memory Intelligence Provider. DLMF owns admission, evidence closure, promotion, merge proof, canonical identity, and canonical writes. A synthesized reflective insight is pending by default and cannot write canonical memory.

## Trigger

The authorized DLMF-SG-004 Production Pilot run `pilot_20260909073110` completed all five sessions and produced:

- 1,195 curated units;
- 15 candidates;
- 8 canonical memories;
- 7 canonical merges;
- zero pending session receipts;
- zero non-preference memories attributed as `user_asserted`.

Semantic quality therefore passed, including the Nancy inline-preference family and the negative task-history controls. The overall pilot nevertheless failed closed because reflection was not run: the designated inferred-insight session correctly produced no canonical memory after epistemic hardening, even though other sessions had eight eligible canonical memories. The same run exposed a retention-accounting false negative because `canonical_merge` was omitted from the terminal curation-outcome total.

The run performed no Hermes writes or deletes, no formal production memory-bank or namespace writes, no pruning, and no insight promotion.

## Decisions

### DR-SG-017 — Canonical reflection fallback

Reflection first selects canonical revisions named by the designated session. When that session has no canonical memory, DLMF selects a bounded fallback from the canonical revisions already admitted during the run. Each canonical identity appears at most once and only at its latest available revision. The selection limit is five and must be a positive integer. With no admitted canonical memory, the pilot records `no_canonical_memories` and remains fail closed.

This changes only the source selection for provider inference. It does not delegate admission, promotion, or canonical-write authority to Hindsight.

### DR-SG-018 — Merge is a terminal curation outcome

`canonical_merge` contributes to the preservation-complete retention total alongside canonical creation, supporting-evidence retention, duplicate handling, invalid input, and policy rejection. This removes a false retention blocker for successfully merged evidence. It does not enable pruning or delete any source material.

### DR-SG-019 — New execution identities

The completion packet uses fresh identities so earlier receipts cannot be mistaken for evidence of the corrected path:

- distillation policy: `pilot-distill-v8-reflection-retention`;
- curation policy: `pilot-curation-v7-reflection-retention`;
- adapter: `hindsight-production-pilot-v0.1.1-reflection-retention-v8`;
- admission policy: `pilot-admission-v1`;
- semantic policy: `dlmf-semantic-v4`;
- reflection policy: `pilot-reflect-v2-canonical-fallback`.

## Executable acceptance

The packet must prove that:

1. canonical reflection source selection prefers designated canonical IDs, falls back to other admitted canonical revisions, stays bounded, and rejects an invalid bound;
2. a receipt containing one canonical creation, five canonical merges, and one supporting-evidence outcome satisfies preservation-complete retention;
3. existing reflective-governance tests continue to keep synthesized insights pending, evidence-open, promotion-ineligible, and unable to perform canonical writes;
4. migrations `0001` through `0005`, the multiprocess semantic-key collision retry, typecheck, build, and the complete test suite pass against disposable PostgreSQL;
5. one newly authorized isolated Production Pilot passes with the pinned manifest and records the reflective candidate without promotion or canonical write.

## Operational authorization and limits

The owner authorized completing implementation, review, and one isolated Production Pilot Apply without repeated approval prompts. This does not authorize automatic pruning, insight promotion, writes to a formal canonical production namespace, push, merge, deployment, or activation of any live runtime.
