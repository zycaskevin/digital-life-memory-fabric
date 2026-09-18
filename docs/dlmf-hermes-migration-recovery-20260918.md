# DLMF Hermes migration recovery — 2026-09-18

Status: **code/tests/preflight verified; post-fix live migration blocked on operator swap recovery**.
Scope: L1 maintenance of the existing isolated Hermes migration pilot. This checkout does not contain a governance-root manifest or policy kernel; no new governance authority is introduced. No Canonical schema, admission policy, memory authority, provider identity, or Relationship OS deployment changes.

## Runtime evidence, not completion claims

The September 18 operator recovery cleared swap at 13:11 Asia/Taipei and the original migration resumed. The durable cursor subsequently advanced from **9797 to 9847**. That advance preceded this fix; it is not evidence that the new limits or retries work in the live workload.

The journal records a failure at **14:08:04 Asia/Taipei**, in `HindsightCanonicalProjectionPort.project`, with `HindsightError: retainBatch failed: "fetch failed"`. A later read-only query shows the failed experience's receipt is already `complete / committed`, with curation coverage and admission complete, and one Canonical memory ID. Thus a valid receipt alone is insufficient to prove projection completion or cursor progress.

Latest inspected durable state: processed **9847**, ingested **7606**, skipped **2241**, source total **11269**, remaining **1422**, `complete=false`. Latest receipt totals: committed **1499**, no-memory-worthy **6128**, awaiting-review **97**, failed **0**, archived **0**. Receipt totals are not counts of distinct Canonical memories and may include receipts ahead of the contiguous cursor.

Both Hindsight health endpoints respond healthy. The migration supervisor is inactive and no writer is active. Governor is red with swap about **11.24 GiB** and no active lease. The exact cause of the renewed swap growth has not been isolated; it must not be attributed solely to this migration without further evidence.

Installed-provider inspection found a default LLM concurrency of 32, worker default 10 slots (8 shared in the live logs), and a native Ollama path using `httpx.AsyncClient(timeout=300.0)`. The runner previously admitted 128 source units concurrently against an Ollama instance with 4 model slots. Logs show connection retries while model requests continued completing. These support reducing request pressure; they do not by themselves prove every timeout or the root cause of swap growth.

## Changes

1. Added `direct-phase2-operational-profile.sh`, sourced by the two existing local `.tmp/ops` wrappers. Defaults are **32 units per round**, **4 source units concurrently**, and **3 total attempts per Canonical projection**. The original Governor lease wrapper and writer advisory lock remain mandatory.
2. Added `canonical-projection-retry.mjs`, wired only to the historical migration's projection port. The default is one attempt unless explicitly enabled. It pins a cloned immutable Canonical revision for retries; the existing port derives the same bank and revision document ID on each attempt. The installed provider upserts document IDs. No new Canonical write or distillation call is introduced by this wrapper.
3. Only the exact installed Hindsight SDK fetch-failure shape or recognized transient HTTP statuses are retryable. Authorization, source validation, projection validation, cancellation, unknown failures, and exhausted retries remain terminal. Backoff is 1 second then 2 seconds. Events contain only a fixed code, attempt numbers, and delay — never source or Canonical text.
4. The supervisor still fails closed on terminal errors. It does not claim completion, auto-approve review cases, skip units, relax resource policy, or loop forever through unknown failures.

## Verification

- `npm run check`: typecheck/build pass; existing suite 200 total, **192 pass / 8 skipped / 0 fail**; new suite **29 pass / 0 fail**. The skipped PostgreSQL integration tests are not counted as passed.
- New tests cover bounded exhaustion, immutable replay, waiting for projection before success, fatal/authorization errors, no-op default behavior, original search delegation, invalid parameters, source isolation, and operational-profile defaults/overrides.
- Existing live preflight passes with maxUnits=32, concurrency=4, unchanged policy fingerprint `24a71ce588719e03`, and unchanged resumable migration fingerprint `9d4805e46a717719`.
- Canonical state JSON hash remained unchanged during modifications and testing. No migration writer or model workload was started by this fix.
- The existing recovery script passes its read-only checks. Its privileged stage has **not** been rerun for the renewed swap hold.

## Operator boundary and next gate

ForgeRelay has `NoNewPrivs=1`; do not attempt privilege bypass or lower Governor thresholds. Run in the normal GB10 operator terminal, as the usual user:

```bash
python3 /srv/workspace/dlmf-qwen-ab/.tmp/ops/recover-swap-and-resume.py --apply
```

It rechecks the existing identity, no active writer/lease, idle healthy Hindsight and sufficient RAM; it requests sudo only for bounded `/swap.img` recycling and restores swap. Its resumed original supervisor now sources the reduced-load profile.

Next verification must show: Governor admission; the same migration fingerprint; exactly one writer; actual **processed > 9847**; successful projections; no new terminal receipt failures; and renewed swap pressure tracked separately. Service `active`, a passed preflight, CPU activity, or provider operations completing is not end-to-end acceptance.

Full closure still requires `11269 / 11269`, `complete=true`, a fresh final run report, no unaccounted source units, reconciliation of outstanding review disposition, and verified retrieval. This document does not close that gate.

## Local evidence and rollback

Operational originals are saved in `.tmp/ops/recovery-hardening-before-20260918.json`. Test log: `.tmp/ops/migration-recovery-check-20260918.log`. Preflight log: `.tmp/ops/migration-recovery-preflight-20260918.log`. No secret or raw memory payload is included in this document.

Rollback is permitted only with no active writer: restore the saved two local wrapper texts and revert this maintenance commit's migration-local files/wiring. Do not roll back the Canonical DB, alter the checkpoint, release another writer's lock, or change review decisions. No merge, production deployment, or upstream push is implied by a local commit.
