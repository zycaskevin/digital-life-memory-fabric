# DLFM-005B Verified Retrieval

**Status:** Locally verified implementation candidate<br>
**Risk:** L1, reversible retrieval boundary and test tooling<br>
**Date:** 2026-09-03 Asia/Taipei<br>
**Base:** Digital Life Memory Fabric `main@6896c9ea38e0a282aab02c8ed8a362b0d7fedd73`<br>
**Provider contract:** OmniHarness `v0.2.0@c1ed422adabc731a75270d9f572db9eed63b34ec`

## Purpose

DLFM-005B closes the provider retrieval to canonical hydration loop without
granting canonical authority to OmniHarness or Hindsight:

```text
Authorized canonical scope + query
  -> MemoryRetrievalPort
  -> OmniHarness memory.search
  -> MemoryRetrievalCandidate[]
  -> untrusted-response validation
  -> canonical ID dedupe
  -> CanonicalVerifier
  -> current canonical revision hydration
  -> VerifiedRetrievalResult
```

Provider scores, ranks, object IDs, and materialization checkpoints remain
retrieval evidence. Returned memory content always comes from Canonical Memory.

## Work Package

### In scope

- provider-neutral search request/result types aligned with OmniHarness v0.2.0;
- caller-supplied freshness constraints passed unchanged to the execution port;
- bounded query, `topK`, filter metadata, response cardinality, and deadline;
- fail-closed validation of provider identity, candidate identity, revision, and
  numeric fields;
- canonical ID deduplication while preserving the first provider rank;
- batch head and revision hydration for in-memory and PostgreSQL stores;
- stale revision, scope, status, temporal, integrity, and read-race suppression;
- live PostgreSQL + OmniHarness + Hindsight retrieval evidence;
- no schema migration.

### Acceptance

1. Provider output is never returned as canonical content.
2. A candidate is allowed only when its claimed revision equals the current
   canonical head in the authorized scope.
3. Tombstoned, superseded, cross-scope, missing, time-invalid, corrupt, stale,
   or concurrently changed candidates are suppressed.
4. Malformed, contradictory, or over-limit provider responses fail the whole
   retrieval closed before canonical hydration.
5. Duplicate candidates for the same memory and revision produce one verified
   item. Duplicates that disagree on revision fail closed.
6. Canonical reads use two bounded head reads around one batch revision read;
   a head that moves during hydration is suppressed as `HEAD_CHANGED`.
7. Provider failure or timeout creates no canonical mutation.
8. A real Hindsight search can return stale and tombstoned provider rows, while
   only the current active canonical revision reaches the verified result.

## API boundary

`MemoryRetrievalPort.search()` receives the provider-neutral
`MemorySearchRequest` and a mandatory abort signal. Its return type is
deliberately `unknown` so `VerifiedRetrievalService` must validate every field.

`VerifiedRetrievalResult.items` contains:

- the hydrated immutable `MemoryRevision`;
- canonical `memoryId` and revision;
- bounded provider evidence: provider ID, original rank, optional score, and
  optional provider object ID.

Provider metadata is not forwarded. Suppressed candidates never contribute
content.

## Verification semantics

Canonical verification checks:

- tenant, Life DID, and memory namespace;
- active head status;
- provider-claimed revision equals the current revision;
- revision/head identity, scope, class, kind, status, and content hash;
- `validFrom <= effectiveAt <= validUntil` when temporal bounds exist;
- the head remains unchanged after revision hydration.

The default `effectiveAt` is the injected clock's current time. Callers may
supply an explicit valid timestamp for a bounded historical read.

## Freshness boundary

Freshness is request-relative. When supplied, `requiredCommitSeq`,
`maxCommitLag`, and `allowRebuilding` are validated and passed unchanged to the
OmniHarness-facing port. Memory Fabric does not invent a canonical sequence or
silently loosen the caller's constraint.

The Hindsight 0.9.2 adapter reports search-visible candidate freshness, not a
bank-wide checkpoint. The live gate therefore makes no provider-wide freshness
claim.

## Live gate

The same local wrapper used by DLFM-005A can start a pinned no-LLM Hindsight
service and run the 005B scenario:

```bash
DLFM_TEST_DATABASE_URL='postgres://...' \
OMNIHARNESS_HINDSIGHT_DATABASE_URL='postgres://.../isolated_hindsight_test' \
OMNIHARNESS_DIR='/path/to/clean/OmniHarness-v0.2.0' \
npm run e2e:verified-retrieval
```

The gate creates a temporary canonical PostgreSQL schema and a unique Hindsight
bank. It materializes three records, advances one canonical revision without
updating its provider representation, tombstones another without deleting its
provider representation, then performs one real search. Cleanup removes the
provider representations and drops the temporary canonical schema.

## Evidence boundary

Passing the gate proves:

- real OmniHarness v0.2.0 `memory.search` contract compatibility;
- real Hindsight 0.9.2 retrieval candidates;
- canonical PostgreSQL hydration;
- stale revision and tombstone suppression even while provider rows remain;
- provider-returned content cannot become canonical output.

It does not prove:

- provider-wide or bank-wide contiguous freshness;
- production authentication, TLS, deployment, or service discovery;
- ContextProjection/privacy policy owned by Self Gateway;
- runtime integration with Hermes, OpenClaw, or Prime;
- external LLM inference;
- multi-provider ranking or shadow comparison.

## Local verification record

On 2026-09-03 Asia/Taipei the candidate passed:

- typecheck and production build;
- all 41 deterministic and PostgreSQL tests with zero skips;
- live PostgreSQL + OmniHarness v0.2.0 + Hindsight 0.9.2 retrieval;
- current canonical hydration, stale revision suppression, and tombstone
  suppression while all three records remained provider-search-visible.

Two initial attempts to start a fresh Python Hindsight process reached service
initialization but missed the bounded readiness window while loading local
embedding models. A separate official Hindsight 0.9.2 container, restricted to
localhost and the disposable pgvector database, passed the gate. An existing
authenticated service was not reused after it correctly rejected an unauthenticated
probe.
