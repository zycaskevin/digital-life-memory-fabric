# DLMF-ADAPTER-001 — Hermes Source Adapter

**Date:** 2026-09-12  
**Status:** In Progress — Adapter core implemented; live production DB UAT pending explicit source-path access  
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
- incremental sync: full
- stable source ID: full
- timestamps: full
- tool events: full
- attachments: unknown
- deletion detection: unknown

Unknown capabilities remain explicit rather than being guessed.

## Live source access status

The production Hermes database was located at the operator-configured Hermes home and is approximately 5.97 GB. AEB can stat the file but its controlled execution sandbox currently denies directly opening that hidden source path. This is treated as a source-access boundary, not bypassed.

Repository production-pilot code and a local Hermes schema fixture confirm the required `sessions` and `messages` schema. Live production DB UAT remains pending an explicitly authorized/readable source path or execution capability.

## Acceptance completed in this increment

- `inspect()` validates required tables and exposes capabilities.
- `discover()` uses bounded cursor pagination.
- `read()` preserves full session/message evidence.
- `fingerprint()` is deterministic for unchanged input.
- `normalize()` produces source-neutral actors/events/content/provenance.
- foreign Experience Units fail closed.
- full repository typecheck, tests, and build pass.

## Next increment

1. Run `HermesSqliteReader.inspect()` against an authorized live/snapshot source.
2. Validate counts and schema version without reading message bodies.
3. Sample bounded Experience Units.
4. Verify repeat-read identity/fingerprint stability.
5. Add checkpoint/resume migration runner.
6. Begin bounded historical migration before full-scale migration.
