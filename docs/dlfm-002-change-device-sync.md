# DLFM-002 — Change & Device Sync

**Status:** Implemented and verified locally, including real PostgreSQL E2E.
**Frozen baseline:** `v0.1.0` / `7d7b97871f6efbf89511d39f6f3c6bf5169381a8`
**Canonical contract:** `docs/canonical-memory-model-v0.1.md`

## Goal

Prove that a logical device can reconnect, replay canonical changes in namespace
order, and durably acknowledge only the changes it has applied.

```text
memory_changes
      |
      v
bounded ordered page
      |
      v
device applies changes
      |
      v
checkpoint compare-and-set
```

## Acceptance contract

1. Change pages are scoped by `(tenant_id, life_did, memory_namespace)`.
2. Every entry carries the change envelope and its immutable canonical revision.
3. Pages are ordered strictly by `commit_seq` and bounded to 1–1000 changes.
4. Replay accepts an explicit `afterCommitSeq` and does not mutate device state.
5. Device pull begins after the durable `lastAppliedCommitSeq` checkpoint.
6. Pulling or retrying never advances the checkpoint.
7. Acknowledgement is explicit and cannot move backward.
8. Acknowledgement validates every sequence between the expected and new checkpoint.
9. Checkpoint persistence is compare-and-set; stale writers fail with
   `DEVICE_CHECKPOINT_CONFLICT`.
10. A checkpoint cannot exceed the namespace committed change high-watermark.
11. A missing sequence fails closed with `CHANGE_SEQUENCE_GAP`.
12. A missing revision, mismatched revision, or invalid envelope payload hash fails with
    `SYNC_REVISION_INTEGRITY_ERROR`.
13. Different devices and namespaces keep independent checkpoints.

## Public service

`MemorySyncService` provides:

- `readChanges(input)` — bounded canonical change feed
- `replay(input)` — explicit replay alias with identical non-mutating semantics
- `pullForDevice(input)` — feed page beginning at the device checkpoint
- `acknowledgeDeviceChanges(input)` — contiguous monotonic checkpoint CAS

The default page size is 100 and the hard maximum is 1000. A caller acknowledges
at most one bounded page at a time.

## Persistence

DLFM-001 already created the `device_checkpoints` table and the scoped
`memory_changes` index in `0001_canonical_core.sql`; DLFM-002 does not require a
schema migration.

The PostgreSQL adapter uses one atomic CTE to update an expected checkpoint or
insert the initial zero-based checkpoint. Concurrent acknowledgements with the same
expected value cannot both advance the device.

Revision hydration is set-based: one query loads every requested immutable revision
and one query loads their evidence, both preserving request ordinality. Page size
does not multiply PostgreSQL round trips per envelope.

The in-memory reference store serializes checkpoint CAS behind the same write
barrier used by canonical transactions.

## Explicit non-goals

DLFM-002 does not implement:

- provider outbox consumption or OmniHarness integration
- provider materialization and rebuild
- supersession or merge mutations
- offline runtime journal storage
- UI state for `LOCAL_PENDING`
- multi-master canonical commits

Those concerns must not bypass Canonical Authority or silently become part of the
device checkpoint contract.

## Verification

Deterministic tests cover bounded replay, bulk immutable revision hydration, retry
before acknowledgement, monotonic checkpoint advance, stale compare-and-set
rejection, backward and future acknowledgement, sequence-gap rejection, corrupt
payload-hash rejection, and device independence.

The PostgreSQL E2E extends the DLFM-001 canonical transaction path with paged device
pull, durable checkpoint creation, stale acknowledgement rejection, resume from the
checkpoint, and final catch-up.

Final local evidence on 2026-09-02: typecheck PASS, build PASS, eleven tests PASS,
zero skips, zero remaining `dlfm_test_*` schemas, and no retained test container.
