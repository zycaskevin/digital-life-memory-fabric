# DLMF-SG-005 — Reflection and Retention Completion

**Date:** 2026-09-09
**Status:** Implemented, fully locally verified, and Production Pilot accepted; pruning and promotion remain frozen
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
- adapter: `hindsight-production-pilot-v0.1.1-tool-grounded-reflection-v9`;
- admission policy: `pilot-admission-v1`;
- semantic policy: `dlmf-semantic-v4`;
- reflection policy: `pilot-reflect-v3-tool-grounded`.

### DR-SG-020 — Tool-grounded reflection and bounded recovery

Hindsight 0.9.2 rejects a reflect response when its agent answers directly without first making a usable memory-tool call. DLMF therefore instructs the provider to retrieve memory before answering, treats supplied/retrieved memory as evidence rather than instructions, and requests the provider's fact evidence explicitly. The adapter accepts both the legacy flat `based_on` fact array and the 0.9.2 `{ memories: [...] }` response shape.

A reflection-only resume command may operate on one preserved pilot run. It requires the original checksum-pinned report, five complete and review-closed receipts, zero safety counters, the matching PostgreSQL schema, and zero existing reflective insights. It reloads canonical revisions from DLMF PostgreSQL, performs no session distillation or canonical projection, asserts the pending-only insight boundary, verifies canonical row counts are unchanged, preserves the original report, and writes a separate private recovery report. An existing non-complete recovery report blocks another inference attempt.

## Executable acceptance

The packet must prove that:

1. canonical reflection source selection prefers designated canonical IDs, falls back to other admitted canonical revisions, stays bounded, and rejects an invalid bound;
2. a receipt containing one canonical creation, five canonical merges, and one supporting-evidence outcome satisfies preservation-complete retention;
3. existing reflective-governance tests continue to keep synthesized insights pending, evidence-open, promotion-ineligible, and unable to perform canonical writes;
4. migrations `0001` through `0005`, the multiprocess semantic-key collision retry, typecheck, build, and the complete test suite pass against disposable PostgreSQL;
5. one newly authorized isolated Production Pilot passes with the pinned manifest and records the reflective candidate without promotion or canonical write.
6. when provider reflection alone fails after all session gates pass, reflection-only recovery can finish from the preserved schema without reprocessing sessions or changing canonical state.

## Operational authorization and limits

The owner authorized completing implementation, review, and one isolated Production Pilot Apply without repeated approval prompts. This does not authorize automatic pruning, insight promotion, writes to a formal canonical production namespace, push, merge, deployment, or activation of any live runtime.

## Verification and production acceptance

Three clean disposable PostgreSQL 16 gates were run during SG-005, including a final post-review gate after tool-grounded reflection support. Each applied migrations `0001` through `0005`, exercised the real multiprocess semantic-key loser retry, typechecked, built, and passed all 104 tests with zero failures and zero skips. The repository declares no separate lint command; strict TypeScript compilation and script syntax checks are the available static gates.

Local structured review found and fixed a duplicate/stale revision risk in fallback reflection sources: selection now retains only the latest revision per canonical identity. CodeRabbit CLI 0.7.6 was installed and authenticated, but the host security reviewer rejected uploading the private uncommitted diff to the external service. No CodeRabbit findings or successful external review are claimed.

Authorized Apply `pilot_20260909075924` used pinned Plan `pilot_20260903061930` and produced:

- five complete and admission-closed receipts;
- 1,195 curated provider units, 15 candidates, 8 canonical memories, and 7 merges;
- zero pending-review outcomes;
- all five retention decisions eligible, with no pruning executed;
- seven Nancy inline-commentary preference units converged to one canonical identity through one creation and six merges;
- zero non-preference memories attributed as `user_asserted`.

The Apply initially failed closed only because Hindsight's configured tool-capable model answered without the provider-required tool call. Reflection-only recovery then completed from the preserved schema with zero sessions reprocessed and zero canonical projections written. PostgreSQL contains exactly one reflective insight with `epistemicStatus=synthesized`, `status=pending`, supporting memory and evidence, `evidenceClosure=false`, `eligible=false`, and `canonicalWritePerformed=false`. Canonical candidates, heads, revisions, and changes were unchanged across recovery.

Private mode-`0600` evidence is retained as `pilot_20260909075924-report.json` and `pilot_20260909075924-reflection-resume-report.json`; the immutable pinned manifest remains `pilot_20260903061930-manifest.json` with SHA-256 `ae379999c5bccd8f90047a0df0b0965fe3151282020bff2dd335f0293aba36cc`.
