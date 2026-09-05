# DLMF Relationship OS Private-Turn Ingress

**Status:** PM-001F integration surface
**Authority:** Digital Life Memory Fabric remains the sole canonical memory authority.

## Purpose

This surface lets Relationship OS submit one already-authenticated, already-resolved private turn to DLMF and retrieve canonical memory context without granting Relationship OS, Hindsight, or the HTTP layer canonical commit authority.

```text
Relationship OS
  -> authenticated DLMF ingress
  -> TranscriptDistillationService
  -> RawExperienceArchiveProvider
  -> Hindsight distillation plane
  -> MD-010 curation + deterministic admission
  -> CanonicalMemoryAuthority / PostgreSQL
  -> Hindsight canonical projection (derived)

Relationship OS cognition recall
  -> authenticated DLMF retrieval ingress
  -> Hindsight canonical projection candidate IDs
  -> CanonicalVerifier
  -> PostgreSQL canonical revision hydration
  -> canonical text only
```

Provider-returned text never becomes the retrieval response. Hindsight supplies only `memory_id + canonical_revision` candidates derived from DLMF projection metadata; the final text is always hydrated from canonical PostgreSQL state.

The Relationship OS projection is a disposable retrieval sidecar only. It does **not** settle DLMF `memory_outbox` or `provider_materializations`; the existing provider-materialization authority remains on the OmniHarness boundary. Sidecar projection failure cannot roll back Canonical Memory and can be repaired by replaying the same completed distillation source.

## Endpoints

- `GET /health` — no private state, no credentials, no database details.
- `POST /v1/relationship-os/transcript-distillations`
- `POST /v1/relationship-os/retrievals`

Both POST routes require an exact Bearer token. Authentication runs before JSON parsing.

The caller cannot choose provider, curation policy, canonicalization policy, admission policy, or retention policy. Those versions are server configuration and are injected after authentication.

## Scope restriction

The ingress is configured with:

- one allowed `tenantId`;
- one allowed `lifeDid`;
- one allowed `memoryNamespace` prefix.

The suffix after that prefix must be exactly 32 lowercase hexadecimal characters. For Nancy, `lifeDid` is character-level while every Relationship receives a separate opaque `relationship.private.<sha256-128>` memory namespace. One Character therefore remains one Life, while private Relationship memories remain namespace-isolated.

## Hindsight planes

`DeterministicHindsightPlaneResolver` derives separate 128-bit SHA-256-named banks per full DLMF scope:

- distillation bank;
- canonical projection bank.

The two bank IDs can never be equal. A different Relationship namespace produces a different pair of banks.

## Deployment boundary

The provided host server deliberately binds only:

- `127.0.0.1`, or
- `::1` / `localhost`.

It refuses `0.0.0.0` or another non-loopback bind. Public TLS must terminate at a trusted reverse proxy / Cloudflare Tunnel. The Bearer token remains mandatory even behind that transport.

Bootstrap uses a dedicated PostgreSQL schema and refuses to auto-repair a partially initialized schema. Raw archives are stored in a configured directory forced to mode `0700`.

## Required environment

```text
DLMF_RELATIONSHIP_OS_DATABASE_URL
DLMF_RELATIONSHIP_OS_ARCHIVE_ROOT
DLMF_RELATIONSHIP_OS_BEARER_TOKEN
DLMF_RELATIONSHIP_OS_TENANT_ID
DLMF_RELATIONSHIP_OS_LIFE_DID
DLMF_RELATIONSHIP_OS_HINDSIGHT_URL
```

Normally also configure:

```text
DLMF_RELATIONSHIP_OS_HINDSIGHT_API_KEY
OMNIHARNESS_DIR
DLMF_RELATIONSHIP_OS_SCHEMA=dlmf_relationship_os
DLMF_RELATIONSHIP_OS_NAMESPACE_PREFIX=relationship.private.
DLMF_RELATIONSHIP_OS_HINDSIGHT_BANK_PREFIX=dlmf-ros-nancy
DLMF_RELATIONSHIP_OS_PORT=8793
```

The server dynamically loads the installed Hindsight client from `OMNIHARNESS_DIR`; DLMF canonical code remains provider-SDK-independent.

## Bootstrap and run

```bash
npm run relationship-os:bootstrap
npm run relationship-os:serve
```

Bootstrap is non-destructive:

- an empty configured schema receives DLMF migrations 0001–0004;
- a complete schema is only verified;
- a partially initialized schema fails closed.

## Privacy and retention

The ingress never logs request bodies. Transport/provider errors are reduced to public error codes and do not echo private content or credentials.

Relationship OS may delete its short-lived post-turn staging only after a DLMF receipt proves a durable raw archive (`rawArchiveRef + rawArchiveChecksum`) and `retentionState` is `preserved` or `prune_eligible`. A successful DLMF receipt may contain zero canonical memories.

## Current integration limitation

The workspace currently contains OmniHarness 0.1.0, not the pinned 0.2.0 retrieval-candidate extension used by the DLMF live-gate documentation. PM-001F therefore uses a DLMF-owned Hindsight canonical-projection adapter whose only retrieval output is canonical IDs/revisions, followed by the same `VerifiedRetrievalService` canonical verification. This is an explicit compatibility bridge, not a claim that OmniHarness 0.2.0 is deployed.
