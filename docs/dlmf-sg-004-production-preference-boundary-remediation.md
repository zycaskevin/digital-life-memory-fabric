# DLMF-SG-004 — Production Preference-Boundary Remediation

**Date:** 2026-09-09
**Status:** Implemented and locally verified; Production Pilot rerun not authorized
**Baseline:** DLMF v0.1.1 Memory Distillation & Provider Boundary Amendment
**Predecessor:** DLMF-SG-003

## Authority invariant

Hindsight remains a replaceable `MemoryDistillationProvider` / Memory Intelligence
Provider. It may extract and propose memory units, but DLMF alone owns epistemic
attribution, semantic identity, admission, merge proof, canonical IDs, and commit
authority. A provider label or lexical match cannot create canonical truth.

## Trigger evidence

Authorized Apply `pilot_20260909063253` reused the checksum-pinned five-session Plan
`pilot_20260903061930`. It processed 1,195 provider units into 25 candidates and 15
canonical memories, then failed closed with seven `pending_review` decisions and no
reflective insight. No Hermes write/delete, production Hindsight bank write, production
canonical namespace write, pruning, or insight promotion occurred.

Manual review found two related defects:

1. Co-occurrence of Nancy, novel/live, and inline terms was treated as a preference
   even when the statement only described a rewrite task or unfinished project state.
2. For provider-declared `preference_candidate` units, generic Chinese `要求` / `希望`
   was evaluated before technical and project-state signals. This preserved
   `user_asserted` on provider paraphrases that were not direct preference assertions.

The semantic collision gate behaved correctly: the seven unrelated statements shared
a mistaken key but were not merged. Reflection was skipped because admission was
incomplete, so that run does not establish ReflectiveInsight acceptance.

## Decisions

### DR-SG-013 — One shared preference-language boundary

The Hindsight adapter and DLMF semantic policy now use the same language-signal module.
English preference verbs must be actor-bound; Chinese `要求` / `希望` must immediately
belong to an actor expression. Generic occurrences inside task descriptions do not
establish a durable preference. Explicit words such as `偏好`, `prefers`, and
`preference` remain valid signals.

### DR-SG-014 — Nancy family requires intent, not co-occurrence

The reviewed Nancy commentary-placement family still requires live/commentary,
inline/interleaving, and narrative/format concepts. It additionally requires either:

- an explicit preference assertion; or
- a normative format rule in which the story, format, live content, or commentary
  must/should be placed inline.

Statements that a rewrite task was initiated, executed, fixed, or remains unfinished
are project state even when they mention the target interleaved style.

### DR-SG-015 — Content classification precedes provider preference labels

After explicit preference intent is ruled out, transient, project-state, and technical
signals take precedence over a provider `preference_candidate` label. A provider
paraphrase with user speaker provenance but no direct preference intent becomes
`uncertain`; it remains supporting evidence and cannot become canonical merely because
the source document was user-facing.

### DR-SG-016 — Advance replay identities

The next separately authorized Apply uses fresh execution identities:

```text
distillationPolicyVersion = pilot-distill-v7-preference-boundary
curationProviderVersion    = pilot-curation-v6-preference-boundary
adapterVersion             = hindsight-production-pilot-v0.1.1-preference-boundary-v7
admissionPolicyVersion     = pilot-admission-v1
semanticPolicyVersion      = dlmf-semantic-v4
```

## Executable acceptance

The regression fixture contains the six task/project descriptions that collided in
the failed run plus the genuine normative Nancy format preference. It proves:

1. all six task descriptions become `project_state/uncertain` and supporting evidence;
2. none receives the Nancy preference semantic key;
3. the genuine format rule remains `preference/user_asserted/affirmative`;
4. that rule merges with the five established English/Traditional Chinese Nancy
   paraphrases into one canonical identity;
5. the receipt completes with one canonical create, five merges, six supporting-only
   units, and zero pending review.

An offline replay of all 32 candidate/pending texts from the preserved failed report
produced 11 Nancy-key rows, eight preference-session project states, one technical-run
project state, and a mixed long-project distribution of project, technical, general,
and preference memories. No non-preference row retained `user_asserted`.

On 2026-09-09, `npm run check` passed against a disposable PostgreSQL 16 tmpfs
container: migrations 0001–0005, the real multi-process semantic-key collision retry,
typecheck, all 104 tests, and build passed with zero failures and zero skips. The
container was stopped and automatically removed.

## Operational boundary

This implementation packet does not authorize a Production Pilot Apply, Hermes
pruning, insight promotion, push, merge, deployment, or deletion of preserved pilot
evidence. A new Apply requires the pinned reviewed Plan and explicit authorization.
