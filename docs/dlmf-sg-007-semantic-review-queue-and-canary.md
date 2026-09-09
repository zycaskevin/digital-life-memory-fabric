# DLMF-SG-007 — Semantic Review Queue and Canary Gate

**Date:** 2026-09-10
**Status:** Implemented and locally verified
**Baseline:** DLMF v0.1.1 Memory Distillation & Provider Boundary Amendment
**Predecessor:** DLMF-SG-006
**Semantic policy:** `dlmf-semantic-v5`

## Authority invariant

Hindsight remains a replaceable `MemoryDistillationProvider` / Memory Intelligence
Provider. It may propose units and reflective hypotheses, but it cannot enqueue a
governed decision as an authority, resolve a semantic review, promote an insight,
prune source data, or write Canonical Memory. Review cases, dispositions, audit
events, canary policy, and any later canonical admission are DLMF-owned.

This packet adds no canonical-write path. It enables neither automatic pruning nor
automatic insight promotion.

## Trigger

Semantic v5 can fail closed as `pending_review`, but the outcome previously existed
only inside a curation record and receipt. There was no independent queue, no
optimistic decision protocol, no append-only disposition history, and no machine
gate for deciding whether a manually reviewed canary was safe to expand.

## Decisions

### DR-SG-027 — Review records are content-minimized

`SemanticReviewCase` stores the curation record and receipt identifiers, life scope,
semantic key and policy, per-memory type, semantic relation, reason codes, trigger,
status, version, and latest decision. It deliberately does not copy transcript text,
provider unit text, canonical content, or reflective propositions.

Review events are append-only. Telemetry consists only of outcome, relation, type,
status, and disposition counts and explicitly declares that raw content and provider
unit text are absent.

### DR-SG-028 — Pending outcomes enter the queue before completion

`TranscriptDistillationService` accepts a narrow `PendingSemanticReviewQueue` port.
After the final curation record is durable, every `pending_review` outcome is
idempotently enqueued. A queue failure makes the distillation receipt fail closed and
keeps pruning disabled; it cannot silently leave an awaiting-review receipt without
an operational review case.

### DR-SG-029 — Decisions are scoped, versioned, and idempotent

A decision must bind an exact case, life scope, expected version, reviewer,
idempotency key, evidence identifiers, reason codes, and an allowed disposition.
The store uses row locking and optimistic versions. Replaying identical intent is
safe; stale versions and reuse of an idempotency key for different intent fail
closed. Deferral is an explicit versioned event and can later be resolved.

Pending-outcome cases allow only contradiction, unrelated, invalid-candidate, or
needs-more-evidence dispositions. Canary samples allow approved-as-classified,
misclassified, or needs-more-evidence. A review decision never mutates its curation
record or Canonical Memory.

All case, receipt, and event reads require the complete memory scope. A foreign scope
is hidden as not found and cannot enumerate review metadata.

### DR-SG-030 — Migration 0006 binds the full source scope

`0006_semantic_review_queue.sql` creates `semantic_review_cases` and
`semantic_review_events`. Composite foreign keys bind case, curation record, receipt,
tenant, life DID, and namespace. Event scope is likewise bound to its case. Database
checks require the status/decision shape and permanently require
`canonical_write_performed=false`.

The PostgreSQL store additionally verifies semantic key, policy version, memory type,
relation, trigger, and reason codes against the governed curation row before enqueue.

Reason-code identity is whitespace-normalized and de-duplicated at both the queue and
gate boundaries, so equivalent source and review metadata cannot collide only because
one path has already normalized it. Migration 0006 records its own application in a
schema ledger. Relationship OS bootstrap upgrades a complete pre-0006 schema exactly
once and refuses partial, tracked-but-missing, or untracked-existing review schemas.

### DR-SG-031 — Production sampling is deterministic and manual

Production Apply queues one deterministic non-pending sample per receipt, preferring
a canonical candidate or merge. It also queues all pending outcomes. The Apply report
contains content-free case metadata and an initial read-only canary assessment.

The operator command is:

```bash
npm run pilot:semantic-review -- pilot_YYYYMMDDhhmmss
```

Without a decision file this command is read-only. It reports `BLOCKED` while cases
remain unresolved and exits non-zero for automation. A reviewed decision file may be
applied with:

```bash
npm run pilot:semantic-review -- \
  pilot_YYYYMMDDhhmmss \
  --apply-decisions /private/path/semantic-review-decisions.json
```

The manifest must pin the exact run and schema, name a reviewer for the same life DID,
and provide exact case version, idempotency key, disposition, evidence IDs, and reason
codes. The resulting private report is mode `0600`, contains no source text, and
proves the canonical candidate/head/revision/change counts were unchanged.

### DR-SG-032 — Eligibility is not activation

`SemanticCanaryGate` is read-only. Expansion is eligible only when curation coverage
and semantic policy match, no `pending_review` outcome exists, all review cases are
resolved, the required number of samples is approved, no sample is misclassified,
and no review case crossed the canonical boundary.

Eligibility does not enable a larger run, pruning, promotion, deployment, or a new
policy. Those remain separate governed actions.

## Decision manifest shape

```json
{
  "runId": "pilot_YYYYMMDDhhmmss",
  "schema": "dlmf_pilot_v011_yyyymmddhhmmss",
  "reviewer": {
    "lifeDid": "did:arthurverse:nancy",
    "agentId": "manual-reviewer"
  },
  "decisions": [
    {
      "caseId": "semrev_exact_case_id",
      "expectedVersion": 1,
      "idempotencyKey": "pilot-run-case-v1",
      "disposition": "approved_as_classified",
      "evidenceIds": ["curation:cur_exact_record_id"],
      "reasonCodes": ["review:manual_sample_approved"]
    }
  ]
}
```

The decision file is an input to an authenticated human-governance process. Merely
creating a syntactically valid file is not evidence that review occurred.

## Executable acceptance

1. Queue records and aggregate telemetry contain no raw/provider text.
2. Re-enqueue is idempotent even when wall-clock timestamps differ.
3. Cross-scope decisions, stale versions, malformed event bindings, and idempotency
   collisions fail closed.
4. Pending contradiction output from the semantic v5 pipeline is automatically
   represented by exactly one review case.
5. Migration 0006 applies after 0001–0005 and enforces full-scope foreign keys and the
   no-canonical-write check.
6. PostgreSQL queue enqueue, resolution, replay, event history, and read-only canary
   assessment round-trip without exposing cross-scope cases or events.
7. The existing two-process semantic-key loser still retries as a governed merge.
8. Production Apply emits deterministic manual samples and keeps Hermes pruning and
   automatic insight promotion frozen.
9. Relationship OS bootstrap upgrades a complete 0001–0005 schema once, records 0006,
   and a second bootstrap is a verified no-op.

## Verification record

On 2026-09-10, the final reviewed implementation ran against an isolated PostgreSQL 16 container
whose data directory was mounted on tmpfs. Migrations `0001` through `0006`, strict
typecheck, the full unit/integration suite, the multi-process semantic collision test,
the pre-0006 bootstrap upgrade/replay test, and the production build completed with
`117/117` tests passing, zero failures, and zero skips. The disposable database
container was then removed.

The repository has no separate lint script; strict TypeScript compilation is its
declared static gate.

## Rollback and activation

Rolling the code back stops new queue writes but does not delete persisted review
cases or events. Migration 0006 is additive; rollback must preserve those audit rows.
No pruning or canonical mutation is needed to roll back sampling.

A production canary must use a checksum-pinned plan, preserve its schema and private
reports, resolve samples through the governed workflow, and record whether the
read-only gate is eligible or blocked. A blocked result is evidence, not permission to
rewrite or delete the source run.
