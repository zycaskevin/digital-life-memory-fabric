# DLMF-SG-010 — Production Insight Promotion Operator

**Date:** 2026-09-10
**Status:** Implemented; production evidence recorded below
**Baseline:** DLMF v0.1.1 Memory Distillation & Provider Boundary Amendment
**Predecessor:** DLMF-SG-009
**Promotion policy:** `dlmf-insight-promotion-v2`

## Outcome

DLMF now provides an explicit `Plan -> Dry-run -> Apply` operator for an accepted,
evidence-closed `ReflectiveInsight`. A checksum-bound plan records the exact insight,
supporting canonical revisions, semantic classification, expected create/merge
operation, promotion policy, and scoped database counts. A separately sealed approval
manifest binds an identified same-life reviewer, external approval evidence,
idempotency key, and bounded validity window to that exact plan.

Plan and Dry-run are read-only. Apply revalidates the plan, manifest, evidence closure,
canonical support revisions, semantic base, and scoped state before invoking the
existing DLMF-owned promotion service. It then verifies exact state deltas and the
ordered append-only events `approved`, `candidate_linked`, `committed`. An identical
replay produces no additional records or canonical revisions.

## Authority invariant

Hindsight remains a replaceable `MemoryDistillationProvider` / Memory Intelligence
Provider. Its identifier and model remain derivation provenance only. Hindsight cannot
create or seal an approval manifest, accept an insight, create a canonical candidate,
or commit Canonical Memory. Those actions remain inside DLMF policy and authority.

`ReflectiveInsight.canonicalWritePerformed` remains `false` even after acceptance:
the canonical commit is performed by the separately invoked DLMF promotion authority,
not by the reflective provider or insight object. Automatic promotion and automatic
pruning remain disabled.

## Decisions

### DR-SG-042 — Preflight is a first-class read-only contract

`ReflectiveInsightPromotionService.preflight` revalidates current active support,
evidence identity closure, accepted-state eligibility, DLMF memory classification,
semantic relation, expected operation, and the exact base revision. It returns only
metadata and hashes; it creates no candidate, promotion record, insight status change,
or canonical revision. Apply uses the same service logic, avoiding a separate planner
policy that could drift from the commit path.

### DR-SG-043 — Plans bind state; approvals bind plans

The plan checksum covers the complete plan, including the insight fingerprint,
supporting revision content hashes, scoped count snapshot, expiry, and disabled
automation flags. The approval checksum covers the plan identity/checksum, reviewer,
external evidence IDs, idempotency key, decision, and validity window. Any mutation,
expiry, wrong life scope, or state change fails closed before promotion.

The checksum is tamper evidence, not a digital signature and not proof of human
identity by itself. The configured operational process remains responsible for the
truth of external approval evidence. Apply stores the approval-manifest checksum as a
durable `approval_manifest:sha256:...` evidence identifier.

### DR-SG-044 — Apply verifies exact closure and replay

A new create promotion must add exactly one candidate, one head, one revision, one
change, one promotion record, and three promotion events. A merge adds no new head.
An exact replay must add zero rows. Any other delta or incomplete event sequence fails
the operator evidence gate.

### DR-SG-045 — Migration rollout is backup- and checksum-bound

The production migration tool requires a non-empty mode-`0600` PostgreSQL schema
backup before it emits a plan. The plan binds backup checksum, migration 0007 bytes,
schema identity, migration ledger, canonical counts, and content-free reflective
insight metadata. Apply requires an exact schema environment guard and verifies that
canonical and reflective-insight invariant state is unchanged by the additive
migration.

### DR-SG-046 — The first production write is an isolated synthetic canary

The seeder accepts only a new `dlmf_promotion_canary_YYYYMMDDhhmmss` schema and refuses
reuse. It applies migrations 0001 through 0007, creates one synthetic reviewed support
memory through DLMF authority, and creates one evidence-closed pending synthetic
insight. Promotion then runs through the same Plan, sealed approval, Dry-run, Apply,
and replay workflow used by later governed operations.

The existing Production Pilot phase-leakage insight is excluded: it remains pending,
ineligible, evidence-open, and `canonicalWritePerformed=false`.

### DR-SG-047 — Relationship OS upgrade is a separate deployment packet

The active Relationship OS deployment predates migrations 0005 through 0007 and has a
different deployed runtime/bootstrap. Applying 0007 directly would violate migration
preconditions. SG-010 therefore neither changes that schema nor restarts its service.
A separate runtime upgrade, backup, compatibility test, and rollout is required.

## Commands

All report, plan, approval, backup, and receipt files are private mode `0600` under the
configured Production Pilot report root.

```bash
# Existing pilot schema: protected backup, migration plan, then guarded Apply.
npm run pilot:insight-promotion:migrate -- plan \
  --schema dlmf_pilot_<id> --backup <protected.dump> --output <migration-plan.json>
DLMF_MIGRATION_APPLY_SCHEMA=dlmf_pilot_<id> \
  npm run pilot:insight-promotion:migrate -- apply \
  --schema dlmf_pilot_<id> --plan <migration-plan.json> --output <migration-report.json>

# A pending evidence-closed insight: Plan, independently sealed approval, Dry-run, Apply.
npm run pilot:insight-promotion -- plan --schema <schema> \
  --tenant-id <tenant> --life-did <life> --namespace <namespace> \
  --insight-id <insight> --output <promotion-plan.json>
npm run pilot:insight-promotion:seal-approval -- \
  --plan <promotion-plan.json> --draft <approval-draft.json> --output <approval.json>
npm run pilot:insight-promotion -- dry-run --schema <schema> \
  --plan <promotion-plan.json> --approval <approval.json> --output <dry-run-report.json>
DLMF_PROMOTION_APPLY_SCHEMA=<schema> npm run pilot:insight-promotion -- apply \
  --schema <schema> --plan <promotion-plan.json> --approval <approval.json> \
  --output <apply-report.json>
```

## Executable acceptance

1. Plan and Dry-run create no promotion or canonical state.
2. Evidence-open, contradicted, non-pending, expired, tampered, cross-life, and stale
   inputs fail closed.
3. Apply persists exact approval evidence and three ordered audit events.
4. Apply uses DLMF candidate and canonical authorities; provider provenance grants no
   authority.
5. Exact replay produces zero row deltas.
6. A complete disposable PostgreSQL migration 0001–0007 and operator E2E passes.
7. The accepted production pilot schema upgrades through backup-bound migration 0007
   without changing canonical or reflective-insight state.
8. One isolated synthetic production canary completes Plan, Dry-run, Apply, and replay.
9. The real phase-leakage insight remains pending/ineligible and no pruning is enabled.

## Rollback

Migration 0007 is additive and governance evidence is append-only. Do not delete or
rewrite promotion records/events to roll back code. Retain the protected pre-migration
backup and reports. If code rollback is required, stop invoking the operator and run a
compatible reader; database downgrade requires a separately reviewed restoration plan.
The isolated synthetic canary schema is retained as evidence and is not a production
canonical source.

## Verification record

On 2026-09-10, the full gate used fresh disposable PostgreSQL schemas and passed
`130/130` tests with zero failures and zero skips, followed by strict TypeScript
typecheck, production build, and `git diff --check`. The suite includes migration
0001-0007, Relationship OS bootstrap upgrade/replay, multiprocess semantic-key
loser-to-merge, multiprocess single-winner promotion, and the operator E2E.

The accepted schema `dlmf_pilot_v011_20260909175112` was backed up as a 406,642-byte
mode-`0600` custom PostgreSQL dump. Migration plan
`migplan_f60e2daf74382227d350003c76472111` applied 0007 exactly once. Before and
after remained 6 candidates, 5 heads, 6 revisions, 6 changes, and 0 promotions. The
real phase-leakage insight remained pending, ineligible, evidence-open, and
`canonicalWritePerformed=false`.

Synthetic schema `dlmf_promotion_canary_20260910224506` used plan
`promplan_7d51662df41ef7dc24f2d2fbb88fc6b8`. Dry-run wrote nothing. Apply produced
exactly one candidate, head, revision, change, promotion, and three ordered events.
The identical replay produced zero deltas. The accepted insight retained Hindsight as
derivation provenance and `canonicalWritePerformed=false`; the canonical commit was
performed by DLMF authority. All reports are mode `0600`, metadata-only, and retain
automatic promotion/pruning as false. The active Relationship OS deployment was not
changed or restarted.
