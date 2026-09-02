# DLFM-003 Central Operations Plane

**Status:** Proposed implementation checkpoint  
**Base:** DLFM-002 Change & Device Sync  
**Authority:** Digital Life Memory Fabric remains the canonical memory authority.

## Purpose

DLFM-003 provides the bounded backend operations needed to inspect one canonical
memory namespace and safely drive its post-commit materialization queue.

It is not an HTTP control plane, user interface, provider registry, or deployment.

## Operations surface

`CentralOperationsService` exposes:

- `readMemoryInventory()` — keyset-paged current canonical heads plus immutable revisions
- `readDeviceFleet()` — keyset-paged durable checkpoints and canonical lag
- `readProviderMaterializations()` — keyset-paged provider projection status
- `getNamespaceSummary()` — bounded memory/outbox/device/materialization counts
- `claimOutbox()` — short-transaction, lease-based worker claim
- `settleOutbox()` — fenced outbox settlement and atomic materialization updates

Every operation requires an explicit:

```text
(tenant_id, life_did, memory_namespace)
```

Authorization is deliberately outside this library. A gateway must authenticate the
caller and authorize that exact scope before invoking the service.

## Queue contract

Canonical commit remains independent of Provider I/O:

```text
Canonical transaction
  -> memory_outbox.PENDING
  -> worker claim / PROCESSING
  -> external Provider I/O (outside database transaction)
  -> fenced settlement
       -> memory_outbox.DONE | FAILED
       -> provider_materializations update
```

Claim rules:

1. A claim is bounded to at most 100 rows.
2. PostgreSQL workers use `FOR UPDATE SKIP LOCKED`.
3. Every claimed row receives `claimed_by`, `claim_token`, and `lease_expires_at`.
4. A failed row is claimable only when `next_attempt_at` is due.
5. An expired `PROCESSING` lease is reclaimable.
6. Reclaiming replaces the claim token and increments `attempts`.
7. A later revision of the same memory cannot be claimed while an earlier revision is unfinished.
8. A stale worker cannot settle after token replacement or lease expiry.
9. Provider materialization revisions cannot move backward.
10. Outbox settlement and provider materialization updates are one transaction.
11. Provider failure never mutates or rolls back canonical memory.

## Inventory and fleet semantics

Memory inventory pages by the current revision's namespace-local `commit_seq`. The
service bulk-hydrates immutable revisions and fails closed if a head/revision/scope
relationship is inconsistent.

Device lag is derived only as:

```text
namespace high-watermark - device last_applied_commit_seq
```

It is operational state, not canonical memory content.

## Migration

`migrations/0002_central_operations.sql` adds outbox lease/fencing fields and
partial indexes for ready retries and expired leases. It does not alter canonical
memory identity, revision history, or `commit_seq` semantics.

## Verified acceptance

The reference tests cover:

- bounded inventory and provider keyset pagination
- namespace isolation
- device lag and summary counts
- disjoint concurrent worker claims
- stale-token rejection
- expired-lease recovery
- delayed retry admission
- atomic successful and failed materialization settlement
- equivalent in-memory and PostgreSQL behavior

## Non-scope

- HTTP or GraphQL API
- web operations console
- authentication, RBAC, or capability grants
- device registration, heartbeat, quarantine, or revocation
- Provider selection, health checks, adapters, or network calls
- OmniHarness delivery worker
- supersession or merge mutations
- deployment, production data migration, or real-device UAT
