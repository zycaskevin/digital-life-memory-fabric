# DLMF-MEM-GOV-001 — Operational Directive Lifetime Governance

**Date:** 2026-09-15  
**Status:** Implemented; existing-memory remediation closed
**Applies to:** DLMF semantic governance, curation, canonical admission, Hermes historical migration

## Problem

One-shot agent execution controls such as `start`, `continue`, `next step`, and progress checks are source experience, but they do not retain useful meaning after the current execution/session finishes. Provider extraction can legitimately surface them, but DLMF must not promote them into durable Canonical Memory merely because a provider labels them as a preference candidate.

This failure mode is named **Operational Directive Leakage**.

## Lifetime rule

The governing question is:

> Does this information still have cross-session value after the current execution/session ends?

One-shot execution controls are `transient`. Durable/recurrent execution rules remain eligible for durable preference treatment.

Examples rejected as transient include:

- start / start the task
- continue / proceed / go ahead / keep going / resume
- next step
- current progress checks
- summaries such as “the user asked the agent to continue”
- summaries such as “the user requested the task to start”

Examples deliberately preserved as durable preferences include rules equivalent to:

- continue automatically when there is no blocker, without asking at every step;
- autonomous execution unless a blocker requires user intervention.

The implementation is contextual rather than a flat keyword blocklist: recurrent/future/default/automatic/unless-blocked scope signals override the one-shot detector.

## Three DLMF-owned enforcement layers

### 1. Semantic governance

`memory-language-signals.ts` detects bounded one-shot operational directives. `DeterministicSemanticMemoryGovernance` evaluates this before preference inference and classifies a hit as `transient_state` with reason code:

`semantic:lifetime:operational_directive_ephemeral`

Semantic policy identity is now:

`dlmf-semantic-v7`

### 2. Conservative curation

`ConservativeMemoryCurationProvider` no longer derives durability only from the provider candidate type. A one-shot directive, or a semantic `transient_state`, receives:

- durability: `transient`
- outcome: `supporting_evidence_only`
- memoryWorthy: `false`

Reason code:

`curation:lifetime:operational_directive_ephemeral`

The default curation identity is now `md010-conservative-v3-lifetime-governance`; Digital Life Stack's default composition uses `dls-conservative-v2-lifetime-governance`.

### 3. Deterministic Canonical admission

Admission independently evaluates the provider-unit text and semantic lifetime reason. Even an over-permissive or replacement curator that proposes `identity_long_term + canonical_candidate` cannot canonicalize a one-shot directive.

Admission forces:

- outcome: `supporting_evidence_only`
- durability: `transient`
- memoryWorthy: `false`

Reason code:

`admission:operational_directive_not_canonical`

This retains evidence/history while failing closed at Canonical admission.

## Historical migration identity

Hermes migration now binds the lifetime policy identities:

- semantic: `dlmf-semantic-v7`
- curation: `hermes-migration-pilot-curation-v3-lifetime-governance`
- admission: `hermes-migration-pilot-admission-v4-lifetime-governance`

The Direct Phase-2 preflight after this change produced:

- migration policy fingerprint: `24a71ce588719e03`
- migration fingerprint: `9d4805e46a717719`

The accepted Direct3700 migration identity was `7760a46680a499ae`, so the new policy does **not** silently reuse the old checkpoint identity.

Bulk migration remains paused. Before Direct3701+, a new migration state must be explicitly seeded from the accepted Direct3700 checkpoint under the new identity; this is an intentional successor transition, not a hidden resume.

## Regression verification

The regression suite contains fixtures covering the required Chinese and English one-shot controls plus durable autonomous-execution preferences. It also includes an adversarial-curator admission test.

On 2026-09-15:

- `npm test`: 188 total / 180 pass / 0 fail / 8 skipped
- `npm run build`: PASS

## Direct3700 contamination dry-run

The `dlmf-semantic-v7` one-shot rule was applied read-only to all active Canonical heads in the accepted Direct3700 PostgreSQL destination.

- active heads scanned: **224**
- remediation candidates: **2**
- database mutations: **0**

Candidate IDs:

- `mem_aa7dc7d58f4f4e05bed0821e4900b472` — one-shot continue directive
- `mem_cb44e8fcedd8487493180eb3d5185e02` — one-shot start directive

This exactly matches the two known Operational Directive Leakage examples. No additional active Canonical head matched the bounded rule.

## Remediation gate

These two IDs were **candidates**, not automatically deleted data. The required remediation sequence was:

1. owner review of the candidate set;
2. governed invalidation/tombstone through DLMF authority;
3. preserve Canonical history and evidence;
4. update downstream projection;
5. replay/refresh verification proving the invalidated memories do not reappear.

SQL hard deletion is prohibited.

## Remediation closure — 2026-09-20

After the full Hermes historical migration reached `11,269 / 11,269`, the lifetime rule was re-run read-only over the completed destination. It scanned `1,472` active Canonical heads and again matched **exactly the same two memory IDs**, with no third candidate.

A guarded DLMF governance operator then applied the remediation through `MemoryCandidateService -> CanonicalMemoryAuthority`; it did not issue SQL deletion or rewrite history.

- `mem_aa7dc7d58f4f4e05bed0821e4900b472`: revision `1 -> 2`, status `tombstoned`;
- `mem_cb44e8fcedd8487493180eb3d5185e02`: revision `1 -> 2`, status `tombstoned`;
- matching Hindsight canonical-projection units: `4 -> 0`;
- post-remediation active-head scan: `1,470` active heads, `0` operational-directive leakage candidates;
- Obsidian projection: `1,470` active notes, `2` excluded tombstoned memories, verification `PASS`;
- inactive-memory leakage into the active graph: none.

The operator is `scripts/governance/remediate-operational-directive-contamination.mjs`. It defaults to dry-run, binds the two reviewed target IDs, fails closed on any unexpected additional match or head/revision drift, and records a private audit report before/after provider projection cleanup.

Canonical history and source evidence remain intact. The tombstones also activate the existing `suppressed_by_governed_forget` behavior: the same semantic memory cannot silently re-enter Canonical Memory merely because its old source experience is replayed.
