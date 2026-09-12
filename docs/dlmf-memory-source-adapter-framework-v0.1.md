# DLMF Memory Source Adapter Framework

Canonical Architecture Amendment v0.1

Date: 2026-09-12  
Status: Proposed Canonical Baseline

## 1. Core boundary

DLMF is not coupled to Hermes, OpenClaw, any Agent, database, SQLite, Markdown, JSON, chat platform, or Memory Provider.

External sources enter DLMF only through a Memory Source Adapter that produces the source-neutral `NormalizedExperience` contract.

```text
Source
  -> Adapter
  -> Normalized Experience
  -> Memory Intelligence
  -> Candidate
  -> Governance
  -> Canonical Memory
```

Source is not memory. Experience Source, Memory Intelligence, and Agent Runtime are not Canonical Memory Authority. DLMF is the authority over Canonical Memory.

## 2. Hermes position

Hermes is an External Experience Source. `state.db` is a Historical Experience Store. `HermesSourceAdapter` is the first reference implementation and MVP validation source, not a permanent DLMF dependency.

## 3. Experience Unit

A source-native session/conversation/thread/document/note/work-session is represented at the DLMF boundary as an `ExperienceUnit`: one independently discoverable, readable, fingerprintable, checkpointable, normalizable unit whose source, version, time and provenance can be traced.

The core contract must never depend on the word `session`.

## 4. Normalized Experience

Every adapter must produce `NormalizedExperience` with:

- source system/type/id and optional observed source version;
- DLMF-owned stable `experienceId`;
- loss-aware start/end timestamps;
- actors and events;
- content and metadata;
- complete source/adapter provenance and source fingerprint.

Unknown or inferred source facts must remain unknown or inferred. An adapter must not manufacture precision that the source does not contain.

## 5. Adapter contract

Every adapter implements:

- `inspect()` — describe source and capability manifest;
- `discover()` — page through Experience Units using bounded cursor-based discovery;
- `read()` — read one Experience Unit into an adapter-owned opaque source payload;
- `normalize()` — translate the opaque payload into `NormalizedExperience`;
- `fingerprint()` — determine whether source content changed.

Adapters translate experience. They do not decide what deserves to become Canonical Memory.

## 6. Stable identity

Stable source identity is the tuple:

```text
(sourceSystem, sourceType, sourceId)
```

`sourceVersion` is mutable observation data and MUST NOT participate in stable identity.

DLMF derives `experienceId` deterministically from stable source identity. Re-reading the same unchanged source must not create a new life event identity.

## 7. Fingerprint

`SourceFingerprint` is content-sensitive and independent from `experienceId`. The v0.1 contract uses SHA-256. Identity answers "which source unit is this?"; fingerprint answers "did its observed content change?".

## 8. Provenance

`ExperienceProvenance` must retain source identity/version/fingerprint, adapter name/version, discovery/read/normalization timestamps, and an optional opaque source locator.

DLMF Core may store but must never parse a source-specific locator.

## 9. Checkpoint

`SourceCheckpoint` records adapter identity, source system/type, optional cursor, last experience identity, last source fingerprint, and update time. Checkpoints are resume state, not Canonical Memory truth.

A repeated import from the same checkpoint or a restart after failure must remain idempotent with respect to stable Experience identity.

## 10. Capability manifest

Every adapter declares support as `full | partial | none | unknown` for:

- historical import;
- incremental sync;
- stable source ID;
- timestamps;
- tool events;
- attachments;
- deletion detection.

DLMF must not assume every source can provide every capability.

## 11. Source-schema prohibition

Hermes table schemas, OpenClaw event schemas, Telegram APIs, Markdown frontmatter, ChatGPT export JSON and all other source-specific representations stop at the Adapter boundary.

DLMF Core must not contain branches such as `if source == hermes`, `if source == openclaw`, or `if markdown`.

## 12. Development order

```text
DLMF-ADAPTER-000  Adapter Contract Freeze
        ->
DLMF-ADAPTER-001  Hermes Source Adapter
        ->
Hermes Historical Migration
        ->
Full-scale Validation
```

Only after Hermes validation should DLMF add generic Markdown/file and OpenClaw adapters.

## 13. DLMF-ADAPTER-000 frozen scope

Only these eight contracts are in scope:

1. Experience Unit
2. Normalized Experience Schema
3. Adapter Interface
4. Source Identity
5. Source Fingerprint
6. Provenance Contract
7. Checkpoint Contract
8. Capability Manifest

No source-specific adapter implementation is part of ADAPTER-000.

## 14. Design principle

DLMF does not answer "which Agent do you use?". It answers "what happened in your past?".

Sources, tools, Agents, models and Memory Providers may change. Canonical personal memory must not require a person to rebuild their life because one of those components changed.

**換 Agent，不等於換人生。**
