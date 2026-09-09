# DLMF-SG-003 — Production Pilot Epistemic Remediation

**Date:** 2026-09-09
**Status:** Implemented; Production Pilot rerun failed manual review and is superseded by DLMF-SG-004
**Baseline:** DLMF v0.1.1 Memory Distillation & Provider Boundary Amendment
**Predecessor:** DLMF-SG-002

## Authority invariant

Hindsight remains a replaceable `MemoryDistillationProvider` / Memory Intelligence
Provider. It may propose memories and insights, but it cannot assign canonical truth,
authorize semantic merges, accept an insight, or write Canonical Memory directly.

## Trigger evidence

Authorized Production Pilot run `pilot_20260909052810` completed its machine gate with
five complete receipts, 1,195 provider units, 22 curated candidates, 18 canonical
memories, four semantic merges, and one reflective insight. Manual review rejected the
result because every admitted candidate became `preference/user_asserted/user`.

The Nancy inline-commentary family did correctly collapse five statements into one
canonical memory at revision 5. The reflective insight was durably stored as
`pending/synthesized`, had no evidence closure, was ineligible for promotion, and had
`canonicalWritePerformed=false`. Hermes writes/deletes and production namespace writes
remained zero.

## Decisions

### DR-SG-009 — Source actor is not epistemic truth

The user-only Hindsight projection carries `dlmf_source_actor=user` but no longer writes
`dlmf_epistemic_status=user_asserted` into document metadata. DLMF permits
`user_asserted` only when a returned unit is a direct preference or habit with explicit
language. Other provider paraphrases from the user projection become `uncertain` and
remain supporting evidence.

### DR-SG-010 — Provider types are advisory

A `preference_candidate` without explicit preference language is reclassified from its
content. Transient, technical, project-state, and event evidence may override the
provider label. Generic `like` examples and proper names such as `A Mind Like Water`
are not preference signals. Generic technical `requires` is not a preference signal.
The reviewed Nancy inline family remains an explicit bounded exception.

### DR-SG-011 — Reviewed multilingual routing concept

English, Traditional Chinese, and mixed `generation 路由` statements that explicitly
prefer the 8B model share the semantic key
`preference:user:model_routing:generation:8b`. Unknown concepts remain normalized exact
identity; no provider similarity score authorizes a merge.

### DR-SG-012 — Inspect first-class insights from their own store

The pilot inspector queries `reflective_insights` when migration 0005 is present and
falls back to legacy derived candidates only for older schemas. This prevents a stored
pending insight from being incorrectly reported as zero.

## Executable acceptance

1. Regression inputs containing `games like`, `commands like`, `candidates like`,
   `A Mind Like Water`, and technical `requires` do not become preferences.
2. Those inputs retain `speakerProvenance=user` as source history but become
   `epistemicStatus=uncertain` and supporting evidence unless independently grounded.
3. Technical, project, transient, and event examples receive distinct per-memory types.
4. English and Traditional Chinese 8B generation-routing preferences merge into one
   canonical identity.
5. The five Nancy inline paraphrases still merge into one canonical identity.
6. The preserved Production Pilot schema reports one pending ReflectiveInsight.
7. Migrations 0001–0005, full tests, typecheck, build, and two-process collision pass in
   a disposable PostgreSQL schema.

## Operational boundary

This packet does not authorize another Production Pilot Apply, Hermes pruning, insight
promotion, merge, deployment, or deletion of the preserved failed-quality pilot schema
and reports. A new Apply requires a reviewed manifest and explicit authorization.

## Verification record

On 2026-09-09, the prior 22 admitted candidate texts were replayed through semantic v3
without provider or production writes. The result was 12 preferences, five technical
facts, three project states, one transient state, and one event. Non-preference units
were `uncertain`; both 8B preferences shared one semantic key. The preserved run
inspector reported `reflective_pending=1` after querying the first-class insight store.

`npm run check` then ran against a disposable PostgreSQL 16 tmpfs container. Migrations
0001–0005, the real two-process collision retry, typecheck, all 103 tests, and build
passed with zero failures and zero skips. The disposable container was stopped and
auto-removed.
