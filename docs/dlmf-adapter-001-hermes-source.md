# DLMF-ADAPTER-001 — Hermes Source Adapter

**Date:** 2026-09-12
**Status:** Live Snapshot UAT PASS — bounded historical migration pending
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

## Next increment

1. Add a bounded historical-migration runner around the frozen snapshot.
2. Persist migration checkpoints outside the source DB.
3. Define migration eligibility separately from source discovery so empty/hidden/source-state sessions are not silently deleted by the Adapter.
4. Run a small bounded migration batch through Memory Intelligence and Governance.
5. Validate retry/resume/idempotency before increasing batch size.
6. Only after bounded validation, begin full-scale historical migration.
