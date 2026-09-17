# DLMF Development Experience Reference v1

Status: local implementation PASS  
Date: 2026-09-17

## Purpose

Development must be able to observe that a real experience happened without forcing that experience to become canonical long-term memory.

The boundary is:

```text
Source Experience
  -> Normalized Experience
  -> content-free Development Experience Reference
  -> Digital-Life-Development evidence

Normalized Experience
  -> distillation / admission
  -> Canonical Memory only when memory-worthy
```

Therefore:

```text
Experience != Memory
Experience != Personality change
```

A greeting may be a real experience while remaining transient and producing no canonical memory.

## Contract

`dlmf.normalized-experience.reference.v1`

The reference contains only:

- DLMF scope;
- stable experience identity;
- source identity and source version;
- SHA-256 source fingerprint;
- bounded timestamps;
- normalization timestamp;
- disposition (`TRANSIENT_SOURCE_ONLY`, `DISTILLATION_SUBMITTED`, or `NO_TEXTUAL_EVIDENCE`);
- optional distillation receipt ID/status.

It never contains message text, transcript, canonical memory content, event payloads, model output, or personality conclusions.

## Incremental Hermes behavior

`HermesIncrementalSyncService` emits one content-free reference for each changed normalized session version.

A pure greeting is still checkpointed and emits `TRANSIENT_SOURCE_ONLY`, while the memory distillation path remains skipped. If the same mutable session later gains durable content, its source fingerprint changes and a new version reference is emitted.

`DLMF_HERMES_DEVELOPMENT_EXPERIENCE_JOURNAL` optionally persists these references as JSONL for a downstream Development consumer. Existing deployments that do not configure the journal remain backward compatible.

## Verification

- DLMF test suite: 190 PASS, 0 FAIL, 8 existing SKIP.
- Synthetic real-process UAT: a Hermes `你好` session produced `developmentRefs=1`, `skipped=1`, `ingested=0`.
- Journal inspection confirmed no conversation content or transcript crossed the boundary.
- Existing Genesis-001 incremental service remained green after the shared worker update.
