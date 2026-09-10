# DLMF-SG-008 — Production Canary Semantic Remediation

**Date:** 2026-09-10
**Status:** Implemented; remediated Production Pilot accepted
**Baseline:** DLMF v0.1.1 Memory Distillation & Provider Boundary Amendment
**Predecessor:** DLMF-SG-007
**Semantic policy:** `dlmf-semantic-v6`

## Authority invariant

Hindsight remains a replaceable Memory Distillation / Intelligence Provider. The
provider may produce units, but DLMF alone classifies memories, determines semantic
identity and relation, performs admission and merge, and owns canonical commits.

This packet does not add a provider canonical-write path. Automatic Hermes pruning
and automatic reflective-insight promotion remain disabled.

## Production evidence

Checksum-pinned Apply `pilot_20260909170351`, based on Plan
`pilot_20260909165701`, processed five real Hermes sessions in an isolated PostgreSQL
schema and pilot Hindsight banks. It produced 1,113 provider units, five candidates,
five canonical memories, and six semantic review cases. Four receipts completed;
the technical-debugging receipt failed closed with one pending review. Reflection
was skipped because the five-receipt set was incomplete.

Manual review was recorded by identified reviewer
`codex-sg007-production-reviewer`:

- two canary classifications were approved;
- three canary memory types were marked misclassified;
- one Traditional Chinese 8B routing preference was semantically equivalent to an
  existing English preference, but semantic v5 returned `unrelated`; the reviewer
  deferred it instead of falsely confirming unrelatedness.

The post-decision gate remained blocked and proved canonical state unchanged.
Hermes deletes, semantic-review canonical writes, automatic pruning, and automatic
insight promotion were all zero.

## Decisions

### DR-SG-033 — A reviewed narrow multilingual concept may merge token-incomparable paraphrases

The `generation_routing_8b` concept already requires an explicit user preference,
the 8B model, and generation-routing language. For equal polarity within this narrow
DLMF-owned family, English and Traditional Chinese paraphrases may be equivalent
even when metadata tails or language-specific wording make normalized token sets
incomparable. Opposite polarity still routes to contradiction review.

Unknown concepts and ambiguous matches retain normalized exact identity and fail
closed. Provider output cannot register or broaden a concept.

### DR-SG-034 — Completed actions, project requirements, and technical constraints are distinct

Memory-level classification now recognizes:

- a completed review/audit/test/migration/deployment as an `event`;
- a task requirement or fresh closure review as `project_state`;
- an execution/quote time window, threshold, or constraint as `technical_fact`.

These rules run per provider unit. They do not inherit the enclosing session
category, and they do not change synthesized content into `user_asserted` content.

### DR-SG-035 — Production execution identities advance

The next Apply uses fresh identities:

```text
distillationPolicyVersion = pilot-distill-v9-semantic-canary-remediation
curationProviderVersion    = pilot-curation-v8-semantic-canary-remediation
adapterVersion             = hindsight-production-pilot-v0.1.1-semantic-canary-remediation-v10
semanticPolicyVersion      = dlmf-semantic-v6
```

The reflection policy is unchanged because this packet does not modify reflection.
Existing reflection-only recovery keeps its original adapter identity.

## Executable acceptance

1. The exact production English and Traditional Chinese 8B statements produce one
   canonical identity with one candidate and one governed merge, with no pending
   review.
2. The exact closure-review statement classifies as `project_state`.
3. The exact quote/execution window statement classifies as `technical_fact`.
4. The exact completed independent-review statement classifies as `event`.
5. All three synthesized fixtures remain `synthesized` rather than inheriting
   speaker provenance as epistemic truth.
6. Opposite-polarity reviewed preferences still route to contradiction review.
7. The complete unit/integration/PostgreSQL/multiprocess suite and production build
   pass before merge.
8. A new production Apply remains checksum-pinned, isolated, manually reviewed,
   and unable to prune or promote automatically.

## Verification record

On 2026-09-10, an isolated PostgreSQL 16 tmpfs container ran the complete
`npm run check` gate. It covered migrations 0001–0006, the pre-0006 Relationship OS
bootstrap upgrade and replay, the two-process semantic-key collision retry, strict
typecheck, all unit/integration regressions, and the production build. The result was
`120/120` tests passing with zero failures and zero skips. The repository has no
separate lint script; strict TypeScript compilation is its declared static gate. The
disposable database container was then removed.

## Preserved blocked evidence

The failed Apply schema, detailed mode-0600 report, content-minimized semantic-review
report, and append-only review decisions remain preserved. They are not rewritten
or deleted after remediation. A new run is new evidence; it cannot retroactively
turn the previous blocked gate into a pass.

## Remediated production result

Plan `pilot_20260909175007` and checksum-pinned Apply
`pilot_20260909175112` completed all five receipts: 1,113 provider units produced
six candidates, five canonical memories, and one governed merge. All five
deterministic manual samples were approved and the read-only gate reported
`ELIGIBLE`.

The eligible result did not activate pruning or insight promotion. Both remained
