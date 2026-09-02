# DLFM-005A Live Materialization E2E

**Status:** Locally verified implementation candidate<br>
**Risk:** L1, reversible integration and test tooling<br>
**Base:** Digital Life Memory Fabric `main@2da8e26a8ce86e9476d4d57267f4283df5281e3e`<br>
**Consumer baseline:** OmniHarness `v0.2.0@c1ed422adabc731a75270d9f572db9eed63b34ec`

## Purpose

DLFM-005A closes the first real provider-materialization loop without changing
canonical ownership:

```text
Canonical commit
  -> PostgreSQL outbox
  -> fenced MaterializationWorker
  -> provider-neutral HTTP POST
  -> OmniHarness OH-MEM-002 consumer
  -> Hindsight 0.9.2
  -> correlated execution receipt
  -> atomic materialization settlement
```

The executable live gate uses real PostgreSQL, the installed OmniHarness v0.2.0
package surface, and a real `hindsight-api==0.9.2` service configured with
`provider=none`. That Hindsight mode performs real document storage and semantic
retrieval without claiming external LLM inference.

## Work Package

### In scope

- a production-usable, provider-neutral HTTP delivery port;
- exact OH-MEM-002 body and correlation headers;
- abort propagation from the fenced worker;
- bounded JSON response handling and fail-closed transport errors;
- cross-repository create, idempotent replay, update, tombstone, inspection,
  transport-outage, and canonical-survival evidence;
- no schema migration.

### Acceptance

1. The HTTP port accepts only absolute `http` or `https` endpoints without URL
   credentials or fragments.
2. It performs one POST per worker attempt and never owns retry scheduling.
3. Request body equals the committed OH-MEM-002 event, and request/idempotency
   identities are also carried as headers.
4. Non-2xx, non-JSON, invalid JSON, empty, or oversized responses fail closed.
5. The worker continues to validate the returned receipt as untrusted data.
6. A real Hindsight document becomes current after canonical create and update.
7. Replaying the same event returns `ALREADY_CURRENT`.
8. Canonical tombstone deletes only the provider representation and is suppressed
   by `CanonicalVerifier`.
9. Transport outage schedules operational retry, creates no fake provider row,
   and leaves the canonical commit readable.

## HTTP boundary

`HttpMemoryMaterializationDeliveryPort` deliberately does not define an
OmniHarness server framework. Deployment code may expose the existing
`MemoryFabricMaterializationConsumer` through its chosen service framework at an
endpoint such as:

```text
POST /v1/memory/materializations
```

The request headers include:

```text
Content-Type: application/json
Accept: application/json
Idempotency-Key: <canonical materialization idempotency key>
X-Request-Id: <OH-MEM-002 request id>
X-Memory-Event-Version: 1
X-Trace-Id: <when present>
```

Authentication headers may be supplied by configuration. Credentials are not
accepted inside the endpoint URL and are never included in transport errors.

## Live gate

The gate requires an isolated PostgreSQL database URL, a separate disposable
PostgreSQL database with the `vector` extension available for Hindsight, and the
exact clean OmniHarness v0.2.0 worktree:

```bash
DLFM_TEST_DATABASE_URL='postgres://...' \
OMNIHARNESS_HINDSIGHT_DATABASE_URL='postgres://.../isolated_hindsight_test' \
OMNIHARNESS_DIR='/path/to/OmniHarness' \
bash scripts/run-live-omniharness-hindsight-local.sh
```

The wrapper builds both TypeScript packages, verifies the pinned Hindsight Python
package and exact OmniHarness commit, starts a temporary no-LLM Hindsight
service, runs the cross-repository
flow, removes provider test documents, drops the Memory Fabric temporary
PostgreSQL schema, and stops the service. The Hindsight URL must name a disposable
test database; Hindsight owns its migrations and tables in that database.

## Evidence boundary

Passing this gate proves local cross-repository wire compatibility and real
Hindsight provider-side materialization. It does not prove:

- production deployment, authentication, TLS termination, or service discovery;
- real Hermes/OpenClaw/Prime runtime UAT;
- external LLM inference;
- verified retrieval and canonical hydration;
- bank-wide contiguous freshness or rebuild;
- npm publication.

Those remain later milestones. OH-HINDSIGHT-003 durable freshness cannot begin
until an authoritative consumer proves ordered, gap-free processing for one
explicit canonical scope.

## Local verification record

On 2026-09-03 the candidate passed:

- all 30 deterministic and PostgreSQL tests with zero skips against PostgreSQL 16;
- live create, idempotent replay, update, tombstone, and provider inspection;
- transport-outage proof that canonical commit survives and no fake Provider
  materialization is created;
- OmniHarness v0.2.0 and Hindsight 0.9.2 contract checks.

The initial live attempt against plain `postgres:16` stopped before execution
because Hindsight correctly requires pgvector. The successful live run used an
isolated PostgreSQL + pgvector database. This is infrastructure evidence, not a
Memory Fabric regression.
