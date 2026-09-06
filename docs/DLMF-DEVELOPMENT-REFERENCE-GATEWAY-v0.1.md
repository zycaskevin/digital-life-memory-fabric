# DLMF Development Reference Gateway v0.1

**Date:** 2026-09-06  
**Status:** Implementation Candidate  
**Purpose:** Live reference-only delivery from DLMF to Digital-Life-Development

## Authority boundary

Digital Life Memory Fabric remains the sole canonical autobiographical memory authority.

The Development Reference Gateway is a read-only delivery surface. It does not create, update, supersede, tombstone, restore, merge, retrieve semantically, distill, curate, or materialize memories.

Its only job is:

> Given an authorized exact memory identity/revision request, return the canonical revision's reference/provenance metadata without returning canonical autobiographical content.

## Why projection happens inside DLMF

`MemoryRevision` contains `canonicalContent.text` and optional payload. If a downstream DLD client received a raw MemoryRevision and discarded content locally, autobiographical content would already have crossed the memory-authority process boundary.

Therefore DLMF owns the transport projection:

```text
CanonicalMemoryStore
       ↓ MemoryRevision (contains canonicalContent)
DLMF server-side reference projection
       ↓ no canonicalContent
Authenticated HTTP boundary
       ↓
Digital-Life-Development
```

## Wire schema

Schema:

`dlmf.development-reference.v1`

Authority:

`digital-life-memory-fabric`

The envelope contains one `reference` with:

- scope: tenant ID, life DID, memory namespace;
- memory ID;
- canonical revision;
- memory status;
- memory class/kind;
- content hash;
- commit sequence;
- epistemic status;
- committed/observed timestamps;
- source-experience references.

It intentionally excludes:

- `canonicalContent`;
- canonical memory text;
- canonical payload;
- provider materialization output;
- semantic retrieval answer text.

## HTTP surface

Reference endpoint:

`GET /v1/development/canonical-references/<memoryId>?revision=<positive integer|current>`

Health endpoint:

`GET /health`

There is no search/list/query endpoint in v0.1.

## Authentication and scope restriction

Reference requests require bearer authentication.

The gateway is configured for one exact allowed DLMF scope:

- tenant ID;
- life DID;
- memory namespace.

Authentication is checked before canonical store lookup. A memory outside the configured scope is returned as `404 not_found` rather than revealing cross-scope existence.

## Current vs historical revision

`revision=current` (or an omitted revision parameter) resolves the canonical head and then retrieves that exact current revision.

An explicit positive revision retrieves the historical canonical revision after first confirming that the memory head belongs to the allowed scope.

If the canonical head references a missing current revision, the gateway returns `canonical_state_incomplete` rather than silently substituting another revision.

## Status semantics

The gateway may return active, tombstoned, or superseded revision metadata.

DLMF reports canonical memory status; it does not decide whether DLD should admit that revision as Development evidence. DLD-I002 currently admits only active revisions and records auditable rejection for non-active revisions.

## Deployment reference

`scripts/development-reference-gateway-server.mjs` follows the existing Relationship OS ingress deployment pattern:

- Node built-in HTTP server;
- loopback-only bind (`127.0.0.1`, `::1`, or `localhost`);
- TLS termination expected in a trusted reverse proxy/tunnel;
- bearer token from environment;
- exact scope allowlist from environment;
- PostgreSQL canonical store with an explicit schema/search path;
- schema preflight before readiness;
- no Hindsight/provider initialization.

Required environment variables:

- `DLMF_DEVELOPMENT_REFERENCE_DATABASE_URL`
- `DLMF_DEVELOPMENT_REFERENCE_SCHEMA`
- `DLMF_DEVELOPMENT_REFERENCE_BEARER_TOKEN`
- `DLMF_DEVELOPMENT_REFERENCE_TENANT_ID`
- `DLMF_DEVELOPMENT_REFERENCE_LIFE_DID`
- `DLMF_DEVELOPMENT_REFERENCE_MEMORY_NAMESPACE`

Optional:

- `DLMF_DEVELOPMENT_REFERENCE_HOST` (default `127.0.0.1`, loopback only)
- `DLMF_DEVELOPMENT_REFERENCE_PORT` (default `8794`)
- `DLMF_DEVELOPMENT_REFERENCE_PG_POOL_MAX`

Start with:

`npm run development-reference:serve`

## Safety invariants

- no raw MemoryRevision serialization across the HTTP boundary;
- no canonicalContent field in the wire contract;
- no memory search/list endpoint;
- bearer auth before store lookup;
- exact scope allowlist;
- cross-scope memory existence not disclosed;
- `cache-control: no-store`;
- `x-content-type-options: nosniff`;
- no provider/Hindsight dependency;
- no memory mutation path.

## Integration ownership

DLMF owns this wire envelope because only DLMF can safely decide what canonical-memory metadata may leave the memory-authority process.

Digital-Life-Development may validate and consume the envelope, but must not redefine DLMF canonical memory truth.
