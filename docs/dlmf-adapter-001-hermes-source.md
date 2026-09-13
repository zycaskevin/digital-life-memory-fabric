# DLMF-ADAPTER-001 — Hermes Source Adapter

**Date:** 2026-09-12
**Status:** Live Snapshot UAT PASS — bounded historical migration PASS; canonical-write/replay canary PASS; strict receipt closure awaiting review
**Depends on:** DLMF-ADAPTER-000 Memory Source Adapter Contract

## Purpose

Hermes is the first reference Experience Source. It is not part of DLMF Core and its SQLite schema must remain behind the Adapter boundary.

Pipeline:

`Hermes state.db -> HermesSourceAdapter -> NormalizedExperience -> DLMF`

## Source mapping

Hermes `sessions` is mapped only inside this adapter to one DLMF `ExperienceUnit`.

| Hermes | DLMF Adapter output |
| --- | --- |
| `sessions.id` | `SourceIdentity.sourceId` |
| `sessions.started_at` | `startedAt` |
| `sessions.ended_at` / `last_activity_at` | `endedAt` |
| `sessions.source`, `profile_name`, counters | metadata |
| `messages.id` | stable adapter-local event ID |
| `messages.role` | actor kind |
| `messages.content` | content/event evidence |
| `messages.timestamp` | event timestamp |
| `tool_call_id`, `tool_calls`, `tool_name` | tool-event evidence |
| `_compressed_summary`, `active`, `compacted` | source-state metadata |

DLMF Core does not import these column names and must never branch on Hermes-specific schema.

## Identity

Stable source identity is:

`hermes / conversation_session / sessions.id`

DLMF derives `experienceId` from that stable identity. Mutable source version data is excluded from identity.

## Version and fingerprint

The adapter exposes a synthetic source version from session counters/activity and the final message ID. Full change detection uses SHA-256 over the complete source payload read for that session.

Re-reading an unchanged session therefore preserves the same `experienceId` and fingerprint.

## Pagination

`discover()` is cursor-based and bounded to 1..1000 units per call. It never loads all Hermes sessions into memory. Current reference ordering uses stable `sessions.id` keyset pagination.

## Temporal semantics

Hermes REAL timestamps are accepted as seconds or milliseconds since epoch; parseable timestamp strings are also accepted. Missing/unparseable values become `certainty=unknown`; the adapter does not invent timestamps.

## Capability manifest

- historical import: full
- incremental sync: partial
- stable source ID: full
- timestamps: full
- tool events: full
- attachments: unknown
- deletion detection: unknown

Unknown capabilities remain explicit rather than being guessed.

## Live source access status

The production Hermes database remains outside the DLMF/AEB workspace. It is not opened directly by the Adapter. The operator creates an SQLite-consistent snapshot through SQLite Backup API and exposes only that snapshot at an explicitly authorized path. The validated snapshot is read-only (`0444`) and approximately 5.97 GB.

Validated snapshot evidence on 2026-09-12:

- Hermes schema version: `30`
- sessions: `11,269`
- messages: `1,000,450`
- session tool-call counter total: `551,236`

This snapshot boundary avoids writing to the live Hermes store, includes committed WAL state at backup time, and gives historical migration a stable input image.

### Live Adapter UAT

The real `HermesSqliteReader -> HermesSourceAdapter` path passed a bounded UAT against the read-only snapshot. No message body was printed as UAT evidence.

A 19-message real session produced 19 normalized events, including 7 tool/message events and user/assistant/tool actors. Repeat reads preserved the same DLMF `experienceId` and SHA-256 source fingerprint.

Checkpoint-only resume was compared with direct cursor resume and returned the same next page with no overlap.

`incrementalSync` is intentionally declared `partial`, not `full`: historical snapshot traversal is resumable, but a mutable live Hermes database can append messages to an existing session and session IDs are not guaranteed to be globally monotonic change cursors. Full live incremental synchronization requires a separate change-detection design.

## Acceptance completed in this increment

- `inspect()` validates required tables and exposes capabilities.
- `discover()` uses bounded cursor pagination.
- `discover()` accepts and validates adapter/source/version-bound checkpoints.
- `read()` preserves full session/message evidence.
- `fingerprint()` is deterministic for unchanged input.
- `normalize()` produces source-neutral actors/events/content/provenance.
- foreign Experience Units and foreign checkpoints fail closed.
- real 5.97 GB snapshot UAT passes for inspect/discover/read/normalize/fingerprint/checkpoint-resume.
- full repository typecheck, tests, and build pass.

## Bounded historical migration acceptance — 2026-09-13

The new Adapter path was exercised against the same read-only 5.97 GB snapshot using an isolated PostgreSQL schema, isolated Hindsight banks, private resumable migration state, and a hard 20-unit bounded sample. No source message body was emitted as migration evidence.

Acceptance evidence:

- cumulative durable migration state: `20` Experience Units processed;
- `2` units entered Memory Intelligence; `18` were explicitly skipped by versioned bounded eligibility rules rather than deleted or silently discarded;
- the resume run processed 10 units with 2 ingestions while the PostgreSQL receipt count moved only `2 -> 3`, demonstrating that one replay reused an existing idempotent receipt instead of creating a duplicate;
- all three persisted distillation receipts are `complete`, with `77`, `73`, and `89` provider units respectively; every receipt has complete curation coverage and `admission_complete=true`;
- one receipt recovered after repeated provider-stage attempts (`attempts=6`) without advancing migration checkpoint prematurely, validating retry/resume behavior;
- the bounded run left `memory_candidates=0`, `memory_heads=0`, and `memory_revisions=0`: conservative governance treated the extracted units as supporting evidence and did not invent canonical truth;
- migration checkpoint is bound to source adapter identity, eligibility-policy version, migration destination identity, and source fingerprint;
- the temporary no-auth Hindsight pilot sidecar was loopback-only and was stopped after acceptance; the normal Hindsight service remained healthy;
- full repository `npm run check` passed after the migration implementation.

This acceptance proves source traversal, normalization, source fingerprint verification, private durable checkpointing, replay/idempotency, Hindsight distillation, curation coverage, deterministic admission, and fail-closed zero-write governance. The bounded sample intentionally produced no admitted canonical candidate, so a separate targeted commit canary was required.

## Canonical commit canary acceptance — 2026-09-13

A targeted canary used a real Hermes session that had already been reviewed in the earlier production pilot as containing durable direct user preferences. The full session remained one Adapter `NormalizedExperience` and was fully archived/provenanced, while Hindsight used the explicit `source_actor_only` Direct Memory Lane. This mode sends only direct user source segments to Memory Intelligence and does not make mixed assistant/tool transcript extraction a prerequisite for canonical user memory. The default Hindsight mode remains `full_plus_source_actor`.

Acceptance evidence:

- source: the same read-only Hermes snapshot, with stable Adapter identity/fingerprint;
- target session: `260` messages / `151` tool calls, while the direct-user projection contained only `13` user rows / approximately `37.6K` characters;
- Hindsight direct-source extraction completed with `115` provider units;
- DLMF curation outcomes: `3` canonical candidates, `4` canonical merges, `1` pending review, and `107` supporting-evidence-only units;
- DLMF committed `3` Canonical Memory IDs while leaving the unresolved unit in `awaiting_review`; the pending review was not auto-approved;
- all `7` candidate provenance checks point back to the Adapter-produced `NormalizedExperience`;
- all `7` committed canonical revisions across those three memories carry matching Adapter Experience provenance;
- raw archive checksum evidence is present;
- replay against the same destination reused the same receipt: `receipts 1 -> 1`, `candidates 7 -> 7`, `heads 3 -> 3`, and `revisions 7 -> 7`;
- replay canary result: `PASS`, with `candidateProvenance=7` and `canonicalProvenance=7`.

This closes the required end-to-end path:

`Hermes snapshot -> HermesSourceAdapter -> NormalizedExperience -> Raw Archive -> Direct Memory Lane -> Hindsight -> Curation -> Governance -> Canonical Memory`

A receipt may legitimately remain `awaiting_review` while already containing governed commits for unambiguous units. Canary success therefore means at least one canonical commit with verified provenance; it does not waive or auto-resolve unrelated pending-review units.

## Requested v1 full-source recovery and replay — 2026-09-13

The originally requested destination was retained rather than replaced:

- schema: `dlmf_pilot_hermes_canonical_canary_v1`;
- namespace: `pilot.hermes-canonical-canary.v1`;
- Hindsight bank prefix: `dlmf-hermes-canonical-canary-v1`;
- reviewed source category: `preference_change`;
- migration fingerprint: `dec15c9e5c361fd1`.

After the 2 GiB Hindsight shared-memory correction, the existing asynchronous full-source operation continued to completion. The DLMF caller that had recorded the earlier ten-minute timeout was no longer active, so an explicit retry reused the same deterministic provider identity and the same DLMF receipt. The receipt advanced from failed attempt `2`, through archived attempt `3`, to an accepted terminal `awaiting_review` state without creating another receipt.

Recovery evidence:

- `processed=1`, `ingested=1`, `skipped=0`;
- `744` provider units and `744` curation decisions with complete curation coverage;
- curation outcomes: `3` canonical candidates, `5` canonical merges, `1` pending review, and `735` supporting-evidence-only units;
- one receipt, `8` candidates, `3` Canonical Memory heads, and `8` revisions;
- all `8` candidate provenance checks point to the Adapter-produced `NormalizedExperience`;
- all `8` canonical revision provenance checks point to the same Adapter experience;
- Hindsight remained healthy with 2 GiB shared memory and returned to zero pending work.

An independent replay state root then forced the same source through the migration runner again while keeping the destination, source, policies, receipt identity, and provider banks unchanged. Replay completed in approximately three seconds and preserved exactly the same receipt, candidate fingerprints, Canonical Memory fingerprints, and canonical truth:

- receipts: `1 -> 1`;
- candidates: `8 -> 8`;
- heads: `3 -> 3`;
- revisions: `8 -> 8`;
- provider units: `744 -> 744`;
- curation decisions: `744 -> 744`;
- candidate provenance: `8 -> 8`;
- canonical revision provenance: `8 -> 8`.

The canonical-write and replay/idempotency canaries pass. The stricter whole-receipt criterion `status=complete`, `canonicalization_outcome=committed`, and `admission_complete=true` remains intentionally open: one durable `user_asserted` preference contradicts an existing semantic target and is held as `merge_required` with `admission:semantic_contradiction_requires_review`. DLMF did not auto-approve or overwrite that conflict. Closing it requires an authorized semantic-review decision bound to the exact pending record; provider completion, more retries, or a new schema cannot supply that authority.

### Direct Memory Lane vs. evidence lane

The commit canary also exposed an operational boundary. A 92K mixed transcript could continue Hindsight processing beyond the former ten-minute provider timeout, while direct user evidence was substantially smaller. DLMF therefore treats these as distinct provider workloads:

- **Direct Memory Lane:** source-actor projection for direct user assertions that can become canonical under governance.
- **Full-source Evidence Lane:** mixed user/assistant/tool context used for supporting evidence and broader extraction. It remains useful but must not block direct user-memory migration.

The complete Experience, provenance, and archive remain source-neutral in both lanes; this split is a Memory Intelligence execution strategy, not an Adapter schema exception.

## Next increment

1. Add bounded chunking/partitioning for large full-source evidence extraction so long Hermes sessions cannot monopolize a provider operation.
2. Preserve deterministic chunk identity, retry identity, provenance, and source-level checkpoint semantics across chunks.
3. Run a 100-Experience staged migration with the Direct Memory Lane enabled and the evidence lane bounded/chunked.
4. After 100-Experience retry/replay/provenance acceptance, increase to 1,000 and then the full frozen snapshot.
5. Keep live incremental synchronization separate; `incrementalSync` remains `partial` until mutable-session change detection is designed.
