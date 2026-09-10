# DLMF-SG-009 — Governed Reflective Insight Promotion Hardening

**Date:** 2026-09-10
**Status:** Implemented and locally verified
**Baseline:** DLMF v0.1.1 Memory Distillation & Provider Boundary Amendment
**Predecessor:** DLMF-SG-008
**Promotion policy:** `dlmf-insight-promotion-v2`

## Authority invariant

Hindsight remains a replaceable `MemoryDistillationProvider` / Memory Intelligence
Provider. It may derive a `ReflectiveInsight`, but it cannot accept or promote that
insight, create a Canonical Memory candidate, perform a canonical commit, or grant
itself approval evidence. DLMF owns the promotion policy, approval verification,
evidence closure, semantic classification, candidate admission, canonical commit,
and audit record.

Automatic reflective-insight promotion and automatic source pruning remain disabled.
This packet hardens an explicitly invoked DLMF-owned workflow; it does not activate
that workflow in production.

## Trigger

The first promotion implementation was fail-closed at the eligibility gate, but a
submission audit found five governance gaps:

- approval-verifier success had no durable approval-evidence identifiers;
- the same insight could be submitted under more than one idempotency key;
- simultaneous processes were not serialized before selecting a promotion record;
- candidate and canonical linkages could be overwritten by a later write;
- insight status and promotion history were not independently monotonic at the
  database boundary.

## Decisions

### DR-SG-036 — Approval evidence is durable input, not an inferred flag

Every promotion request and record carries one or more explicit
`approvalEvidenceIds`. The request must identify an actor in the same life scope and
pass the configured DLMF approval verifier. Replays must bind the same reviewer,
approval evidence, policy version, scope, and insight. A boolean verifier result alone
is insufficient durable evidence.

Migration 0007 marks pre-existing records with
`legacy:approval-verifier-only`. The marker preserves migration truth; it does not
upgrade legacy approval into newly reviewed evidence.

### DR-SG-037 — One insight has one governed promotion lineage

`insight_promotion_records.insight_id` is unique. The service also checks the
insight index before work begins, so a second idempotency key for the same insight
fails closed instead of creating a parallel promotion lineage.

The PostgreSQL store holds a scope-and-insight advisory transaction lock while the
workflow runs. A simultaneous process waits, then replays the single committed
record. The in-memory store implements the same keyed serialization contract.

### DR-SG-038 — Promotion state and linkage are monotonic

A promotion may move only from `approved` to `committed`; `rejected` is terminal.
Once a candidate or canonical memory is linked, a later write cannot replace it.
`updatedAt` cannot regress. The database enforces the same rules as the TypeScript
stores.

Each meaningful transition emits one deterministic append-only event:
`approved`, `candidate_linked`, `committed`, or `rejected`. Event rows bind the full
life scope and reference the governed promotion, candidate, and canonical head.
Updates and deletes of events are rejected.

### DR-SG-039 — Reflective insight acceptance is governed at the database boundary

A new insight must start `pending`. Status transitions are monotonic, immutable
derivation/evidence fields cannot change, and an `accepted` transition requires
eligible, evidence-closed policy output plus an approved or committed promotion
record in the same scope.

`PostgresReflectiveInsightStore` therefore uses an insert path for pending creation
and an update-only path for later states. An accepted or rejected object cannot be
smuggled in as a new row through an upsert.

### DR-SG-040 — Migration and bootstrap fail closed on ambiguous history

`0007_insight_promotion_governance.sql` adds approval evidence, the unique insight
lineage, append-only events, and database transition triggers. It refuses to create
the unique index when existing data contains multiple promotion rows for one insight;
those rows require manual review.

Relationship OS bootstrap applies migrations 0001 through 0007 to a new schema,
upgrades a complete pre-0006 schema through 0006 and 0007 exactly once, and refuses
tracked-but-missing or untracked-existing promotion-event state.

### DR-SG-041 — Eligibility and implementation are not production activation

No Production Pilot insight is promoted by this packet. In particular, a
Hindsight-synthesized insight with open evidence remains `pending`,
`canonicalWritePerformed=false`, and ineligible. Production promotion requires a
separate, identified, evidence-bearing decision and an explicitly invoked governed
workflow. Provider output can never satisfy that authority boundary by itself.

## Executable acceptance

1. Empty approval evidence, anonymous reviewers, replay input drift, and a second
   idempotency key for one insight fail closed.
2. Two local processes simultaneously promoting the same insight and semantic key
   return the same promotion, candidate, and canonical memory identifiers.
3. The collision produces exactly one promotion record, one canonical candidate,
   and the ordered event sequence `approved`, `candidate_linked`, `committed`.
4. Direct ungoverned acceptance, state regression, immutable-field mutation,
   candidate-link replacement, canonical-link replacement, and event mutation fail.
5. Migration 0007 applies after migrations 0001 through 0006, and Relationship OS
   upgrades and replays a pre-0006 schema without duplicate migration records.
6. A PostgreSQL promotion store configured with only one connection fails fast;
   governed promotion requires at least two pool connections because one connection
   holds the cross-process lock while the workflow uses the store transaction paths.
7. Hindsight receives no canonical authority, and automatic promotion and pruning
   remain disabled.

## Verification record

On 2026-09-10, a disposable PostgreSQL 16 container used a tmpfs data directory and
ran `npm run check`. The gate applied migrations 0001 through 0007, exercised the
pre-0006 bootstrap upgrade/replay, ran the existing semantic-key loser retry and the
new two-process insight-promotion collision, typechecked the strict TypeScript graph,
ran all unit/integration tests, and built the production package.

The result was `126/126` tests passing with zero failures and zero skips. The
repository has no separate lint command; strict TypeScript compilation and
`git diff --check` are its available static gates. The disposable database is
removed after the final post-review gate.

## Rollback and operations

Rolling code back must not delete `insight_promotion_records` or
`insight_promotion_events`; they are governance evidence. Migration 0007 is additive
and intentionally has no destructive automatic downgrade. Legacy approval markers
require manual review before any reuse.

Production deployments that invoke the PostgreSQL promotion service must configure a
pool of at least two connections. This constraint is checked before acquiring the
advisory lock so a bad deployment fails immediately rather than waiting indefinitely.
