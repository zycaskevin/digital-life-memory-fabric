# DLMF-SG-011 — Hermes Canonical Canary Review Remediation

**Date:** 2026-09-13
**Status:** Implemented; real Hermes canonical-commit canary and replay PASS
**Baseline:** DLMF-ADAPTER-001 and DLMF-SG-007
**Predecessor:** DLMF-SG-010

## Outcome

DLMF can now consume one durable, append-only `invalid_candidate` semantic-review
decision when retrying the exact Hermes Experience that produced the reviewed
`pending_review` record. The decision rejects only that exact contradictory provider
unit. All other provider units continue through the normal Curation, Admission, and
Canonical Memory authorities.

The remediation creates a new policy-bound logical receipt. It does not mutate the old
receipt, rewrite a curation record, delete a review event, auto-approve a candidate, or
grant Hindsight canonical authority.

## Authority invariant

Hermes remains an Experience Source. Hindsight remains a replaceable Memory
Intelligence Provider. The semantic reviewer supplies a bounded governance decision,
but does not write Canonical Memory. DLMF alone verifies the decision, creates
candidates, applies Admission, and commits Canonical Memory.

Automatic promotion and automatic Hermes pruning remain disabled.

## Decisions

### DR-SG-048 — Review remediation is exact and fail-closed

An `invalid_candidate` binding covers all of:

- DLMF scope;
- source type and source identity;
- provider-unit reference;
- a reviewed-candidate fingerprint;
- semantic key and semantic-policy version;
- memory type and speaker provenance;
- semantic relation and exact target Canonical Memory ID;
- durable review case, decision, source curation record, case version, and disposition.

The reviewed-candidate fingerprint hashes the provider-unit text together with the
source, scope, semantic classification, relation, and target. Raw text is never emitted
as evidence. A mismatch returns no remediation and preserves `pending_review`.

Provider run identity and other execution metadata are deliberately excluded from this
semantic fingerprint. Hindsight may materialize the same deterministic unit in a new
provider run; that does not change the proposition the Owner reviewed. Provider-unit
fingerprints remain stored on curation records for provider audit and retry checks, but
they do not redefine a human semantic decision.

### DR-SG-049 — Durable review evidence is revalidated before use

The migration operator accepts only a regular, non-symlinked private decision manifest
with no group/world permissions. Before creating the remediation policy it joins the
durable review case, latest append-only review event, and source curation record. It
requires exact scope, reviewer, idempotency key, evidence IDs, reason codes,
`invalid_candidate` disposition, resolved version, original `pending_review`
outcome, and `canonicalWritePerformed=false`.

Any missing or changed field fails before migration.

### DR-SG-050 — A reviewed retry is a new logical receipt

The remediation identity is part of DLMF receipt idempotency, and the reviewed
admission-policy version is distinct from the unreviewed policy. The migration identity
also includes the decision-manifest fingerprint and remediation contract version.
Therefore an old `awaiting_review` receipt remains immutable evidence while the
reviewed policy produces one new logical receipt.

The strict canary flag requires `complete / committed / admissionComplete=true`.
The ordinary canonical-canary mode may still accept the separately documented
`awaiting_review` partial-commit state.

### DR-SG-051 — Replay resolves only the matching policy receipt

A checkpoint-complete replay selects the receipt for the exact source and current
admission-policy version. It must not accidentally aggregate older receipts for the
same source under different governance policies. Replay must preserve receipt,
candidate, head, revision, review-event, and Canonical truth state.

## Real Hermes verification record

The retained destination was used; no replacement schema was created:

- schema: `dlmf_pilot_hermes_canonical_canary_v1`;
- namespace: `pilot.hermes-canonical-canary.v1`;
- Hindsight bank prefix: `dlmf-hermes-canonical-canary-v1`;
- reviewed source category: `preference_change`;
- remediation migration fingerprint: `d6c824a23eb397e0`.

The Owner selected decision B: retain the prior reviewed preference and classify the
new contradictory provider unit as an invalid candidate. The first remediation
contract failed closed because its match included a full provider-unit fingerprint.
Content-free diagnosis proved that source identity, provider-unit reference, text hash,
text length, semantic reasons, epistemic attribution, speaker, and target memory were
identical. The full provider-unit fingerprint still drifted across materializations;
the provider run was also different, so the remaining drift was correctly treated as
provider-execution/evidence metadata rather than a changed reviewed proposition. That
failed receipt and its review case were retained as audit evidence.

The v2 exact-semantic remediation then passed the strict real-source canary:

- `processed=1`, `ingested=1`, `skipped=0`;
- receipt `complete / committed / admissionComplete=true`, attempts `1`;
- `744` provider units and `744` curation decisions with complete coverage;
- outcomes: `735` supporting-evidence-only, `8` canonical merges, `1`
  review-remediated rejection, and `0` pending review;
- receipt candidate IDs: `8`; Canonical Memory IDs: `3`;
- all `8/8` candidates point to the Adapter-produced `NormalizedExperience`;
- all three current Canonical revisions point to the same Adapter Experience;
- cumulative matching revision provenance across those memories: `24`;
- strict result: `canonicalCanary=PASS`.

The exact replay was source-checkpoint complete and produced no writes:

- `processed=0`, `ingested=0`, `skipped=0`;
- receipts `3 -> 3`;
- candidates `24 -> 24`;
- heads `3 -> 3`;
- revisions `24 -> 24`;
- the successful receipt stayed at attempts `1`;
- candidate-set and Canonical-memory-set fingerprints were unchanged;
- Canonical truth fingerprint remained `ab22528a7fcf227a`;
- replay result: `canonicalCanary=PASS`.

The review case created by the earlier fail-closed attempt was then matched to the same
reviewed semantic fingerprint and resolved with its own curation-record evidence.
Both historical review cases are now append-only `resolved / invalid_candidate`,
and semantic-review application verified that canonical state was unchanged. The
separate Expanded Manual Canary gate remains blocked because it requires approved
sample decisions and because historical receipts preserve their original
`pending_review` outcomes; that gate is not rewritten by remediation.

No Hermes state was modified, no existing pilot evidence was deleted, no Relationship
OS schema/service was used, and no private message body or credential was emitted as
acceptance evidence.

## Deployment boundary

This record proves the requested real-source canonical-commit canary, bounded human
semantic decision, exact provenance, and same-source replay idempotency. It is not by
itself proof of a packaged release, hosted CI, deployment, continuous live Hermes
incremental synchronization, or production activation. Those remain separate gates.
