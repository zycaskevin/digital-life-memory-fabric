# DLMF Multi-Source Continuous Ingestion

Architecture Amendment v0.1

Date: 2026-10-01

Status: Proposed Canonical Baseline

## 1. Purpose

DLMF accepts durable life experience from multiple external sources without making any source, Agent, runtime, chat product, or knowledge system the Canonical Memory Authority.

This amendment extends the existing Memory Source Adapter architecture from Hermes historical/live ingestion to reusable incremental observation for Codex and captured ChatGPT conversations.

The core invariant remains:

```text
Source != Memory
```

A source record may be observed, normalized, fingerprinted, deferred, or distilled. Only DLMF governance can admit Canonical Memory.

## 2. Authority topology

DLMF and AKF are parallel authorities with different semantics.

```text
Hermes / Codex / ChatGPT / future sources
                 |
        +--------+--------+
        |                 |
        v                 v
 DLMF Source Adapters   AKF Capture
        |                 |
        v                 v
 NormalizedExperience   Evidence / Knowledge
        |                 |
        v                 v
 DLMF Memory Authority  AKF Knowledge Authority
```

DLMF owns Canonical Memory admission, identity, provenance and memory commits.

AKF owns durable knowledge records and their provenance.

Lifetime Hub separately owns Digital Life identity and continuity.

A DLMF Source Adapter must never write AKF knowledge. An AKF capture path must never write DLMF Canonical Memory directly.

Cross-authority movement occurs only through the existing governed, target-owned proposal/promotion/admission boundaries. Delivery or approval by one authority is not acceptance by another.

## 3. Incremental source observation

Mutable sources use a source-neutral polling checkpoint:

- adapter name and version;
- source system and source type;
- exact DLMF Memory scope (tenant, life DID, namespace);
- processing mode (reference-only vs distillation) and source-policy identity;
- one SHA-256 evidence fingerprint per stable source ID;
- checkpoint update time.

The checkpoint is source observation state, not Canonical Memory truth. A checkpoint from another life scope, processing mode, policy identity, adapter version, or source identity fails closed rather than suppressing work in the new destination. One durable checkpoint has one active writer: in-process runs are serialized, and the file-backed store takes an exclusive run lock before source submission so overlapping pollers cannot duplicate ingestion or regress a newer checkpoint. The checkpoint path is canonicalized against its real parent and direct checkpoint/journal symlink aliases fail closed.

Per-source progress is appended as an O(1) private delta journal. Journal permissions are tightened before any private delta is written, each committed append is synchronized, and a torn unterminated tail is discarded while preserving complete preceding records. Compaction synchronizes the replacement snapshot and directory entry before retiring the journal, then synchronizes journal removal. A restart replays committed deltas before resuming.

An incremental pass:

1. discovers bounded source units;
2. fingerprints the evidence projection;
3. skips unchanged checkpointed versions;
4. reads and normalizes changed versions;
5. verifies the source did not change during normalization;
6. applies a source policy decision:
   - `distill`
   - `source_only`
   - `defer`
7. advances the source fingerprint only after a safe terminal outcome.

A non-terminal/failed distillation receipt does not advance the source fingerprint.

A current-state baseline is also lifecycle-aware: sources whose policy returns `defer` remain pending and are not fingerprinted as processed. This allows the same evidence to become eligible later when an active conversation closes or a journal becomes idle.

Evidence equality is not sufficient to prove ingestion eligibility. Sources whose eligibility depends on mutable lifecycle state (for example Codex idle time or ChatGPT active/completed status) re-read and verify a separate eligibility-state key from the same final source sample before acting on the distillation decision.

## 4. Defer semantics

`defer` is required for an active or not-yet-stable conversation.

A deferred version is intentionally **not checkpointed as processed**.

This permits:

```text
same content fingerprint
active -> defer
later session close / idle gate
same fingerprint -> distill
```

No artificial content mutation is required to make an already-finished conversation eligible.

This prevents temporary work instructions, partial turns, or in-progress agent activity from becoming Canonical Memory merely because they were observed once.

## 5. Codex source

Current implementation status: **real local source supported**.

Source:

```text
injected Codex sessions root
  -> recursive read-only *.jsonl discovery
  -> CodexSourceAdapter
  -> NormalizedExperience
  -> DLMF
```

The concrete reader is root-injected; DLMF core does not assume `$HOME`. Discovery ignores symlinks and each actual file read revalidates canonical-root containment against the opened file descriptor. The current hardened local reader is Linux-only and fails closed when descriptor containment cannot be verified on another platform. Session lookup uses an ID index and cursor pages use binary search over the same strict code-unit total ordering, including an exact-string distinction for canonically equivalent Unicode spellings.

Modern Codex journals may share a higher-level `session_id` while carrying distinct journal/thread `id` values. The adapter therefore uses `session_meta.id` as the stable Experience Unit identity and falls back to `session_id` only for older journals that do not expose `id`.

The adapter admits assistant output text and only **provably owner-authored** Codex user text as memory evidence. A direct single-part user input can qualify. Multi-part `role=user` envelopes are treated conservatively because Codex can inject AGENTS/environment/context into that role: known host wrappers are excluded, and a composite qualifies only when exactly one unambiguous non-host input part remains. Repetition frequency is never used as authorship evidence.

The following are excluded from NormalizedExperience evidence:

- developer/control-plane messages;
- base instructions;
- encrypted reasoning;
- world state;
- token telemetry;
- function/tool call bodies and tool outputs.

The evidence fingerprint is calculated from the same selected user/assistant evidence. Operational metadata-only changes therefore do not redistill old conversations.

Codex incremental ingestion defaults to a five-minute idle gate. Journals newer than that threshold are deferred without checkpoint advancement. The threshold is configurable. Journal mtime/source-version state is revalidated separately from the selected-message evidence fingerprint. Sessions with no provable user-authored text are source-only.

## 6. ChatGPT source

Current implementation status: **DLMF local capture contract implemented; ChatGPT cloud publisher not connected**.

DLMF accepts one strict versioned local snapshot per conversation:

```text
dlmf/chatgpt-captured-conversation/v1
```

The snapshot contains:

- stable `conversationId`;
- source revision;
- `active | completed | archived` status;
- start/update timestamps;
- explicit messages.

Only user/assistant text is projected into DLMF memory evidence. System/tool bodies remain outside the memory evidence projection.

`active` snapshots are deferred without checkpoint advancement. `completed` and `archived` snapshots may be distilled. Status/revision/update time are revalidated separately from message evidence before distillation, so a lifecycle regression cannot hide behind an unchanged message fingerprint. A completed conversation that later changes gets a new evidence fingerprint and re-enters the incremental path.

This contract is the DLMF receiving boundary. It does **not** assert that ChatGPT cloud history is currently being exported automatically. A separate authorized capture publisher is still required to produce these snapshots.

## 7. Scheduling recommendation

Continuous ingestion should not mean immediate Canonical Memory mutation on every message.

Recommended cadence:

```text
source changes
   |
   +-> frequent lightweight observation / fingerprinting
   |
   +-> session-close or idle gate -> distillation attempt
   |
   +-> nightly consolidation -> replay/retry/dedup/health checks
```

Recommended defaults:

- Codex: poll periodically; distill after at least five minutes idle or an explicit future close signal.
- ChatGPT capture: publisher may update active snapshots frequently; DLMF distills only after `completed` or `archived`.
- Nightly: process only unresolved/new deltas and retry-safe receipts. Do not re-import all historical content every night.

No timer or production scheduler is installed by this amendment. Any future scheduler must preserve the existing one-writer-per-checkpoint lock boundary or introduce an equivalent explicit CAS/lease before multi-writer activation.

## 8. Relationship to Hermes

Hermes remains a first-class source and its existing live incremental implementation remains valid.

This amendment does not replace Hermes-specific transient/background policies. It provides a generic incremental source primitive for other sources whose lifecycle rules differ.

Hermes, Codex and ChatGPT therefore share the same DLMF source-neutral boundary without being forced into one source-specific schema.

## 9. Stop line

This amendment is complete at the repository level when:

- generic incremental checkpoint/defer semantics pass focused and repository regression tests;
- Codex fixture tests prove control-plane/reasoning/tool evidence exclusion;
- a real local Codex journal can be discovered/normalized in read-only reference-only UAT without emitting transcript content as evidence output;
- ChatGPT capture active-to-completed behavior is verified with identical message evidence;
- malformed/duplicate/symlink inputs fail closed or are safely ignored as specified;
- no production Canonical Memory writer, timer, ChatGPT cloud exporter, or AKF mutation is activated by the implementation.

Activation of a ChatGPT cloud publisher and production scheduling are separate deployment decisions.

## 10. Repository acceptance evidence — 2026-10-01

Candidate baseline:

- base: `origin/main@b483faeb8a399e19cf34d45548894573becdc184`;
- implementation remains repository-only: no production Canonical Memory writer, timer, ChatGPT cloud publisher, or AKF mutation was activated.

Verification:

- focused multi-source / filesystem hardening suite: **53 / 53 PASS**;
- full repository `npm run check`: **275 tests total / 267 pass / 8 skip / 0 fail**;
- canonical projection retry suite: **29 / 29 PASS**;
- TypeScript typecheck: PASS;
- build: PASS.

Real Codex read-only UAT:

- source: two real local Codex journals from the 2026-09-30 session directory;
- discovered/scanned: **2 / 2**;
- Canonical Memory ingestion: **0**;
- DLMF references: **2 REFERENCE_ONLY**;
- emitted reference surface contained no `content`, `events`, or `transcript` fields;
- one journal contained only excluded/control-plane user-role material and normalized to `userMessageCount=0`, confirming the owner-evidence filter on real data.

Independent review:

- initial defect-first review found lifecycle, source-evidence, checkpoint, concurrency, pagination, containment, and performance defects; each was repaired with focused negative controls;
- subsequent review identified baseline lifecycle, journal-recovery locking, and FIFO-replacement edge cases; each was repaired and rerun;
- final focused independent reviewer verdict: **No P0-P2 findings.**

Remaining activation gaps are intentional stop-line items, not repository completion claims:

- ChatGPT cloud publishing into the local capture contract is not connected;
- recurring polling / nightly scheduling is not installed;
- real Codex owner-authored distillation into production DLMF was not activated;
- downstream ingest-to-checkpoint crash replay still relies on the existing downstream idempotency contract.

## 10. Verification status — 2026-10-01

Candidate base: `origin/main@b483faeb8a399e19cf34d45548894573becdc184`.

Repository-level evidence after hardening:

- focused multi-source incremental suite: **48 / 48 passed**;
- repository Node test suite: **270 total / 262 passed / 8 intentionally skipped / 0 failed**;
- canonical projection retry suite: **29 / 29 passed**;
- TypeScript typecheck: **PASS**;
- build: **PASS**;
- independent defect-first review was iterated through lifecycle race, source-authorship, checkpoint-scope, concurrency, pagination, symlink/containment, crash-recovery and privacy findings, with regression tests added for each accepted defect.

A real local Codex reference-only UAT against the 2026-09-30 journal set previously discovered and normalized two real journal units and emitted only content-free `dlmf.normalized-experience.reference.v1` references with `ingested=0`. That UAT also exposed the real `session_meta.id` vs shared `session_id` identity distinction that is now encoded in the adapter. A later attempt to inspect private selected-message counts was blocked by the host safety layer and was not bypassed.

Not activated by this amendment:

- no ChatGPT cloud/export publisher;
- no periodic timer, cron or nightly scheduler;
- no production Codex/ChatGPT Canonical Memory writer;
- no AKF mutation from DLMF;
- no merge, push or production deployment.

## 11. Activation Phase contract — 2026-10-01

The repository now defines a deployment candidate for continuous multi-source operation without changing the authority model.

### Default write mode

Every Codex/ChatGPT scheduled worker defaults to:

```text
DLMF_MULTI_SOURCE_WRITE_MODE=reference_only
```

In this mode:

- PostgreSQL/Hindsight writer composition is not instantiated;
- no Canonical Memory receipt may be emitted;
- changed source versions become content-free DLMF Development references only;
- checkpoints may advance for observed/reference-only source versions.

Canonical Memory distillation requires the explicit operator setting:

```text
DLMF_MULTI_SOURCE_WRITE_MODE=distill
```

The distill path then reuses the existing DLMF Digital-Life-Stack runtime composition and its target-owned admission/governance. The source worker itself gains no canonical authority.

### Codex polling

The Codex one-shot worker observes the configured local `.codex/sessions` root, keeps a separate private incremental checkpoint, applies the configured idle gate, and can run as a user-systemd timer.

Codex source identity is **physical-journal based** as of `CodexSourceAdapter 0.2.0`. Modern Codex can reuse one logical `session_meta.id` across multiple physical rollout files, including divergent branches. DLMF therefore derives a stable source ID from the logical Codex ID plus the source-root-relative journal locator. The original logical ID remains provenance metadata only. This preserves every branch instead of forcing Source Adapter collision resolution to discard evidence; semantic duplication remains a downstream DLMF governance concern. Because this changes source identity semantics, 0.1.x Codex incremental checkpoints are intentionally incompatible and fail closed.

`--preflight` inspects the real source and, in distill mode, verifies DLMF/Hindsight/schema readiness without creating or advancing a source checkpoint.

`--baseline-current` establishes the current source watermark. In reference-only deployment this is the required first activation step so old local history is not accidentally treated as newly-arrived work.

### ChatGPT capture publisher receiving boundary

The ChatGPT activation path is deliberately split:

```text
authorized publisher
   -> loopback ChatGPT capture inbox
   -> private v1 snapshots
   -> ChatGptCaptureIncrementalSyncService
   -> DLMF
```

The capture inbox:

- binds loopback only;
- authenticates a bearer token before parsing the private request body;
- accepts only `application/json`;
- enforces a bounded body size;
- validates `dlmf/chatgpt-captured-conversation/v1`;
- stores snapshots under a hash-derived filename, never a raw conversation ID;
- uses owner-private atomic files;
- rejects stale, conflicting, and lifecycle-regressing snapshot updates;
- performs **zero Canonical Memory writes**.

This inbox is a receiving/publisher boundary. It does **not** provide direct ChatGPT cloud-history access. A separately authorized ChatGPT-side publisher/connector is still needed to send real cloud conversations into this local boundary.

### Scheduling

The deployment candidate supplies user-systemd templates for:

- Codex delta sync every five minutes;
- ChatGPT capture inbox as an always-on local receiver;
- ChatGPT capture delta sync every five minutes;
- nightly multi-source delta consolidation.

Nightly consolidation invokes the same checkpointed delta paths. It is a retry/health pass over new, mutated, or unresolved source versions; it is not a historical full re-import.

### Canary-first activation

Production-wide `distill` is not the first deployment step.

Required activation order:

1. deploy and verify `reference_only`;
2. baseline existing source roots;
3. prove real incremental deltas and content-free references;
4. create a separately identified DLMF canary schema/bank/scope or equivalent approved isolation;
5. enable `distill` only for the canary runner;
6. verify exact DLMF receipts, canonical effects, replay idempotency, retrieval, and rollback evidence;
7. broad production write activation remains a separate evidence gate.

DLMF and AKF remain parallel authorities throughout this activation. None of these workers or timers may directly mutate AKF knowledge.

## 12. Activation candidate verification — 2026-10-01

The activation candidate was hardened through repeated independent review before any live canary:

- repository main suite: **292 total / 284 passed / 8 intentionally skipped / 0 failed**;
- canonical projection retry suite: **29 / 29 passed**;
- activation-specific suite: **11 / 11 passed**;
- TypeScript typecheck: **PASS**;
- build: **PASS**;
- final independent release-gate review: **No P0-P2 findings** after closing concurrency, stale-lock, journal durability, torn Codex tail, checkpoint mutation, credential isolation, canary-boundary, and filesystem durability findings.

The independent Verifier/QA canary negative control also passed: attempts to target production memoryNamespace=life in distill mode were rejected unless an explicit isolated canary-* namespace is bound. Its sandbox could not complete the full suite because that sandbox denies local loopback-listen and mkfifo; the authoritative GB10/ForgeRelay Node 24 regression above exercised those host capabilities directly.

Live reference-only and isolated distillation canary evidence are recorded separately from repository acceptance so deployment state is never inferred from tests alone.

### 2026-10-02 live activation evidence

- real Codex reference-only UAT against the complete local `~/.codex/sessions` tree exposed duplicate logical session IDs with divergent physical rollouts; the pre-0.2.0 adapter failed closed before activation;
- after moving source identity to physical journals, the same full-root baseline passed with **1,185 journal source units**, **0 ingestion**, and **0 failed receipts**;
- an immediate replay observed **1,183 unchanged** journals and **2 legitimately changed** live journals while Codex was still active, demonstrating delta capture rather than historical replay;
- authenticated ChatGPT loopback inbox canary accepted one completed synthetic snapshot and explicitly reported `canonicalMemoryWrites=0`; reference-only sync then produced **1 Development reference / 0 ingestion**;
- isolated distillation canary scope `canary-multi-source-20261002` completed with **1 terminal receipt**, `admission_complete=true`, `canonicalization_outcome=no_memory_worthy_content`, **0 candidates**, and **0 canonical memories**;
- the production `life` namespace had **0 receipt/candidate matches** for that synthetic canary source, proving the canary did not contaminate production life memory;
- broad production `distill` remains disabled. Reference-only sidecar deployment is the next activation step.


## 13. Reference-only sidecar activation — 2026-10-02

The multi-source repository candidate was activated on Nancy as **reference-only sidecars** from the exact resident release:

`613004e48114c23ea5bdb68df6420cc7c84c3bc5`

This deployment does not replace or restart the existing Hermes living-memory path.

Activated user-systemd units:

- `digital-life-dl-nancy-chatgpt-capture-inbox.service`: enabled and active, loopback `127.0.0.1:19007`;
- `digital-life-dl-nancy-codex-memory-sync.timer`: enabled and active, every five minutes;
- `digital-life-dl-nancy-chatgpt-memory-sync.timer`: enabled and active, every five minutes;
- `digital-life-dl-nancy-multi-source-nightly.timer`: enabled and active, 03:17 local with up to ten minutes randomized delay.

Operational evidence:

- rendered units passed `systemd-analyze --user verify`;
- official Codex baseline: **1,187 physical journals / 0 ingestion / 0 failed receipts**;
- first manual post-baseline Codex delta: **1,188 scanned / 4 changed / 4 reference-only / 0 ingestion**;
- first automatic Codex timer run: **1,188 scanned / 1 changed / 1 reference-only / 0 ingestion**;
- manual nightly consolidation: **PASS**, `historicalFullImport=0`, Codex **3 changed / 3 reference-only / 0 ingestion**, ChatGPT **0 ingestion**;
- ChatGPT inbox `/health` and `/ready` both returned PASS with `canonicalMemoryWrites=0`;
- the live inbox process contains capture-specific environment only and no `DLMF_DLS_*` writer variables or production distill write mode;
- the production ChatGPT capture root was empty at activation because a ChatGPT cloud-side publisher is **not yet connected**;
- production Codex Development references were verified as `REFERENCE_ONLY`, `authority=digital-life-memory-fabric`, and contain no `content`, `events`, or `transcript` surface;
- private config, token, checkpoint, and reference journal files are owner-only `0600`.

Production-wide `DLMF_MULTI_SOURCE_WRITE_MODE=distill` remains **disabled**. The only write-enabled validation was the separately scoped `canary-multi-source-20261002` run described above.

Rollback is non-destructive: disable the three multi-source timers and the ChatGPT capture inbox. Existing Hermes/Nancy memory ingestion remains untouched. The pre-activation ForgeRelay checkpoint is `cp_dded69fad0`.
