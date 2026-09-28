# DLMF-SG-012 — Semantic v8 Review Closure

**Date:** 2026-09-28  
**Status:** Implemented and production-applied  
**Scope:** Nancy DLMF primary + read-only historical retrieval view

## Purpose

Close legacy semantic-review cases without rewriting their original receipts or
granting a provider Canonical Memory authority.

The original pending receipts remain immutable audit evidence. Review closure is
append-only and cannot write Canonical Memory.

## Schema governance

Migration `0009_semantic_review_policy_supersession.sql` advances the DLS DLMF
schema contract from `current-0008` to `current-0009`.

It adds the semantic-review disposition:

- `policy_superseded`

A `policy_superseded` decision is fail-closed unless it binds:

- the governed curation record;
- the exact prior semantic-policy version;
- a non-empty successor policy;
- a successor reevaluation receipt.

No automatic production schema upgrade is permitted. Existing `current-0008`
schemas are `stale-0008` until explicitly upgraded.

## Semantic policy v8

`dlmf-semantic-v8` preserves the v7 lifetime boundary and adds reviewed fixes for
legacy false collisions:

- Traditional Chinese interaction preference can merge paraphrases with unrelated
  formatting qualifiers;
- game-series third-person narration is a separate semantic context from
  first-person self-expression;
- rejecting separated/end-of-episode stream sections while requiring inline Nancy
  commentary is affirmative inline placement, not a contradiction;
- A/B preference experiments are not treated as settled user preferences;
- one-shot task requests such as reviews/reports do not become durable preferences;
- incidental `自動化` no longer satisfies the durable cross-session
  `自動` operational-preference signal.

Opposite Nancy inline preferences remain review-gated.

## Production closure

The production review queue contained 108 open cases.

The v8 deterministic reevaluation reduced them to:

- 86 `policy_superseded`;
- 22 `confirmed_unrelated`;
- 0 pending;
- 0 deferred.

The review-resolution operation preserved Canonical Memory counts exactly.

Two primary Canonical heads were separately identified as legacy semantic
contamination and governed with tombstone revisions:

- a smoke-test completion-notification task misclassified as a notification
  preference;
- a Traditional-Chinese preference mixed with a one-shot final-review task.

The remediation used CanonicalMemoryAuthority, preserved prior revisions, performed
no hard delete, and removed their Hindsight projection documents. Verified retrieval
confirmed both tombstones are suppressed.

## Production schema upgrade

Before the explicit `0008 -> 0009` upgrade, PostgreSQL 18 schema-only dumps were
taken for both primary and historical schemas with owner-only permissions and SHA-256
checksums.

Both schemas then upgraded with exactly one migration. Canonical heads, revisions,
receipts, and review counts were unchanged by the migration itself.

## Verification

- Node 24 regression: 221 tests, 213 pass, 0 fail, 8 DB integration skips.
- Production Node 22 regression: same result.
- Projection retry: 29/29 pass.
- PostgreSQL integration: 5/5 pass.
- DLMF ingress readiness: `current-0009`.
- Primary + historical verified retrieval: pass.
- Wrong-scope and unauthorized requests remain rejected.
- Governed tombstones are not returned.

Production evidence is stored under:

`~/.local/share/digital-life/nancy-resident/memory-runtime/activation-evidence/semantic-v8-closure-20260928/`

This closes the semantic-review governance gate. Fresh owner-originated Nancy
conversation UAT remains a separate end-to-end acceptance gate.
