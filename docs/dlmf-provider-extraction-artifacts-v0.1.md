# DLMF Provider Extraction Artifacts v0.1

**Date:** 2026-09-14  
**Status:** Engineering Contract  
**Scope:** Memory Intelligence execution / retry reproducibility

## Purpose

DLMF must be able to use a stateless or non-persistent Memory Intelligence Provider without making retry semantics depend on a second LLM call returning identical text.

The execution boundary is therefore:

`Raw Experience -> Provider Extraction -> Provider Extraction Artifact -> Curation -> Governance -> Canonical Memory`

A Provider Extraction Artifact is **not Canonical Memory** and is **not a MemoryCandidate**. It is immutable evidence of exactly what one Memory Intelligence execution returned before DLMF semantic attribution and canonical governance.

## Ownership boundary

DLMF owns artifact identity, persistence, integrity verification, and replay semantics.

The Memory Intelligence Provider owns extraction only. A provider may be Hindsight, a future provider, or a local/cloud model adapter. The artifact contract must not depend on Hermes or Hindsight storage schemas.

## Artifact identity

An artifact identity binds:

- memory scope;
- source type and source ID;
- provider name;
- provider adapter version;
- provider version when declared;
- distillation policy version;
- a fingerprint of the complete provider-visible Experience.

The provider-visible Experience fingerprint includes the archive reference/checksum, content type, temporal fields, metadata, and source-role segments. Runtime timestamps such as the provider request time are deliberately excluded.

## Immutability and retry

The first successful provider extraction is validated and persisted before curation begins.

If curation, admission, canonicalization, or a later downstream step fails:

1. the receipt retains `providerExtractionRef` and `providerExtractionChecksum`;
2. retry must resolve and verify that exact artifact;
3. retry must not call the Memory Intelligence Provider again;
4. any identity/checksum drift fails closed.

If a receipt references an artifact but the runtime no longer has a Provider Extraction Artifact Store configured, DLMF fails closed instead of silently regenerating provider output.

## Storage

v0.1 provides:

- `ProviderExtractionArtifactStore` source-neutral interface;
- in-memory implementation for deterministic tests;
- filesystem implementation with private files, content verification, atomic no-clobber creation, and collision rejection.

The filesystem artifact checksum covers the immutable identity plus raw `DistillationResult`. The artifact is stored before DLMF rewrites epistemic attribution, memory type, speaker provenance, or semantic key.

## Receipt / PostgreSQL contract

Migration `0008_provider_extraction_artifacts.sql` adds only:

- `provider_extraction_ref`
- `provider_extraction_checksum`

Both fields must be absent together or present together. Once recorded, their binding is immutable at the PostgreSQL layer.

Canonical Memory tables are unchanged.

Digital-Life-Stack schema state advances from `current-0007` to `current-0008`. Existing `current-0007` schemas become `stale-0007` and require an explicit upgrade; no implicit production upgrade is allowed.

## Acceptance evidence

v0.1 is accepted only when all of the following hold:

- a provider extraction succeeds and downstream curation intentionally fails;
- retry completes without a second provider call;
- artifact ref/checksum remain identical across retry;
- filesystem writes replay the same artifact and reject a same-identity/different-result collision;
- PostgreSQL round-trips artifact bindings and rejects binding drift;
- `stale-0007` fails closed without explicit upgrade and upgrades only to `current-0008` when authorized;
- the full repository typecheck/test/build gate remains green.

## Follow-on

Only after this contract is stable may a Direct Memory Lane use Hindsight `dry-run-extract` or another stateless extractor. Stateless extraction must write a Provider Extraction Artifact before curation, so retry replays DLMF-owned evidence rather than asking the model to recreate the past.
