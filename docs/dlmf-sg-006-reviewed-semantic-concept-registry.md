# DLMF-SG-006 — Reviewed Semantic Concept Registry

**Date:** 2026-09-09
**Status:** Implemented and locally verified
**Baseline:** DLMF v0.1.1 Memory Distillation & Provider Boundary Amendment
**Predecessor:** DLMF-SG-005
**Semantic policy:** `dlmf-semantic-v5`

## Authority invariant

Hindsight remains a replaceable `MemoryDistillationProvider` / Memory Intelligence
Provider. Provider text is evidence. Hindsight cannot register a semantic concept,
choose a semantic identity, resolve a contradiction, issue a merge proof, promote an
insight, or write Canonical Memory. Those remain DLMF-owned decisions.

This packet does not enable automatic pruning, automatic insight promotion, or a new
canonical write path.

## Trigger

The first semantic policy deliberately automated only the production-verified Nancy
inline-commentary family and used normalized exact identity elsewhere. SG-002 added
small ad hoc multilingual rules for dark mode, notifications, and 8B generation
routing. The behavior was useful but the rules, polarity handling, and subsumption
features were embedded in one policy class and could not fail closed when a statement
matched multiple concepts or contained incomparable qualifiers.

## Decisions

### DR-SG-021 — Reviewed, code-owned concept allow-list

Automatic semantic identity is now backed by a DLMF-owned registry. The registry is
not provider-configurable at runtime. Adding or broadening a family requires a code
change, policy-version change, and regression fixtures.

The reviewed v5 families are:

- Nancy live-commentary placement;
- 8B generation routing;
- dark mode;
- notifications;
- Traditional Chinese interaction language;
- third-person narrative style;
- short-games-first ordering.

Only a unit classified independently as a user preference with
`speakerProvenance=user` may enter these families. The provider's session category,
candidate label, or semantic key cannot force a match.

### DR-SG-022 — Ambiguity and unknown concepts remain exact

Zero registry matches use normalized exact identity. More than one registry match is
also treated as exact identity and records `semantic:concept_ambiguous:<ids>` in the
curation reason codes. This prevents one compound statement such as “dark mode and
notifications” from silently merging into either atomic concept.

Exact repeats may still merge evidence. A reordered or paraphrased unknown/ambiguous
statement receives a different key and cannot auto-merge.

### DR-SG-023 — Polarity is a contradiction gate

The registry evaluates affirmative, negative, and unknown preference stance after a
concept match. Same-key opposite stances produce `contradicts` and
`pending_review`. Unknown stance and malformed compound stance produce `unrelated`
and also require review. Negated English actor expressions such as “User does not
prefer …” and Traditional Chinese negative preferences are recognized without
conflating the speaker with epistemic authority.

### DR-SG-024 — Generalized qualifier subsumption is conservative

English and Traditional Chinese aliases become stable comparison features only after
a reviewed concept key matches. Equal feature sets are equivalent. A strict feature
superset is recorded as `candidate_subsumes_existing` or
`existing_subsumes_candidate`. The reviewed `all devices` feature expands to mobile
and desktop coverage, so it may subsume either device-specific form.

Incomparable feature sets are `unrelated`, not equivalent. The sole exception is the
Nancy placement family: its five production-verified paraphrases intentionally permit
incomparable surface features to resolve as equivalent. No similarity score, model
judgment, embedding distance, or provider assertion can authorize a merge.

### DR-SG-025 — No database migration is required

Migration `0005_semantic_governance.sql` already persists semantic key, policy
version, relation, speaker provenance, per-memory type, and curation reason codes.
SG-006 changes policy behavior and test coverage without changing persisted shape.
A synthetic `0006` migration would create no safety or compatibility value and is
therefore intentionally absent.

## Executable acceptance

1. English and Traditional Chinese forms of interaction language, third-person
   narrative, and short-games-first preferences merge within their reviewed family.
2. Same-concept positive and negative notification preferences share a key but route
   to contradiction review.
3. `all devices` dark-mode preference subsumes a mobile-device form; mobile-only and
   night-only qualifiers are unrelated and require review.
4. A statement matching multiple registered concepts uses exact identity; an exact
   repeat merges while a reordered paraphrase remains separate.
5. A non-user speaker cannot acquire a reviewed user concept or `user_asserted`
   status from provider content.
6. The original Nancy and 8B regressions remain green under policy v5.
7. Migrations `0001` through `0005`, both PostgreSQL integrations, strict typecheck,
   full tests, and build pass in a disposable PostgreSQL instance.

## Verification record

On 2026-09-09, the final candidate ran against a fresh PostgreSQL 16 container with
its data directory on tmpfs. The integration path applied migrations `0001` through
`0005`, exercised the two-process semantic-key collision and governed loser retry,
and completed strict typecheck, build, and all 110 tests with zero failures and zero
skips. The disposable container was then stopped and automatically removed. The
repository declares no separate lint script; strict TypeScript compilation is the
available static gate.

## Rollback and activation

Rolling code back to semantic v4 stops new v5 classifications; immutable revisions
and their recorded policy versions remain canonical history. No row is deleted or
rewritten. Because the semantic policy version participates in distillation
idempotency, a later v5 production run is a distinct governed execution and must not
be confused with the accepted SG-005 v4 pilot.

SG-006 itself performs no Production Pilot Apply, pruning, promotion, deployment, or
runtime activation.
