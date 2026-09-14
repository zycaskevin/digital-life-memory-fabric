# DLMF-ADAPTER-001 — Hermes Source Adapter

**Date:** 2026-09-12
**Status:** Live Snapshot UAT PASS — bounded migration / strict canonical-commit remediation / replay / full-source chunking / Direct1000 PASS / Evidence1000 PASS
**Depends on:** DLMF-ADAPTER-000 Memory Source Adapter Contract

## Purpose

Hermes is the first reference Experience Source. It is not part of DLMF Core and its SQLite schema must remain behind the Adapter boundary.

Pipeline:

`Hermes state.db -> HermesSourceAdapter -> NormalizedExperience -> DLMF`

## Source mapping

Hermes `sessions` is mapped only inside this adapter to one DLMF `ExperienceUnit`.

| Hermes | DLMF Adapter output |
| --- | --- |
| `sessions.id` | `SourceIdentity.sourceId` |
| `sessions.started_at` | `startedAt` |
| `sessions.ended_at` / `last_activity_at` | `endedAt` |
| `sessions.source`, `profile_name`, counters | metadata |
| `messages.id` | stable adapter-local event ID |
| `messages.role` | actor kind |
| `messages.content` | content/event evidence |
| `messages.timestamp` | event timestamp |
| `tool_call_id`, `tool_calls`, `tool_name` | tool-event evidence |
| `_compressed_summary`, `active`, `compacted` | source-state metadata |

DLMF Core does not import these column names and must never branch on Hermes-specific schema.

## Identity

Stable source identity is:

`hermes / conversation_session / sessions.id`

DLMF derives `experienceId` from that stable identity. Mutable source version data is excluded from identity.

## Version and fingerprint

The adapter exposes a synthetic source version from session counters/activity and the final message ID. Full change detection uses SHA-256 over the complete source payload read for that session.

Re-reading an unchanged session therefore preserves the same `experienceId` and fingerprint.

## Pagination

`discover()` is cursor-based and bounded to 1..1000 units per call. It never loads all Hermes sessions into memory. Current reference ordering uses stable `sessions.id` keyset pagination.

## Temporal semantics

Hermes REAL timestamps are accepted as seconds or milliseconds since epoch; parseable timestamp strings are also accepted. Missing/unparseable values become `certainty=unknown`; the adapter does not invent timestamps.

## Capability manifest

- historical import: full
- incremental sync: partial
- stable source ID: full
- timestamps: full
- tool events: full
- attachments: unknown
- deletion detection: unknown

Unknown capabilities remain explicit rather than being guessed.

## Live source access status

The production Hermes database remains outside the DLMF/AEB workspace. It is not opened directly by the Adapter. The operator creates an SQLite-consistent snapshot through SQLite Backup API and exposes only that snapshot at an explicitly authorized path. The validated snapshot is read-only (`0444`) and approximately 5.97 GB.

Validated snapshot evidence on 2026-09-12:

- Hermes schema version: `30`
- sessions: `11,269`
- messages: `1,000,450`
- session tool-call counter total: `551,236`

This snapshot boundary avoids writing to the live Hermes store, includes committed WAL state at backup time, and gives historical migration a stable input image.

### Live Adapter UAT

The real `HermesSqliteReader -> HermesSourceAdapter` path passed a bounded UAT against the read-only snapshot. No message body was printed as UAT evidence.

A 19-message real session produced 19 normalized events, including 7 tool/message events and user/assistant/tool actors. Repeat reads preserved the same DLMF `experienceId` and SHA-256 source fingerprint.

Checkpoint-only resume was compared with direct cursor resume and returned the same next page with no overlap.

`incrementalSync` is intentionally declared `partial`, not `full`: historical snapshot traversal is resumable, but a mutable live Hermes database can append messages to an existing session and session IDs are not guaranteed to be globally monotonic change cursors. Full live incremental synchronization requires a separate change-detection design.

## Acceptance completed in this increment

- `inspect()` validates required tables and exposes capabilities.
- `discover()` uses bounded cursor pagination.
- `discover()` accepts and validates adapter/source/version-bound checkpoints.
- `read()` preserves full session/message evidence.
- `fingerprint()` is deterministic for unchanged input.
- `normalize()` produces source-neutral actors/events/content/provenance.
- foreign Experience Units and foreign checkpoints fail closed.
- real 5.97 GB snapshot UAT passes for inspect/discover/read/normalize/fingerprint/checkpoint-resume.
- full repository typecheck, tests, and build pass.

## Bounded historical migration acceptance — 2026-09-13

The new Adapter path was exercised against the same read-only 5.97 GB snapshot using an isolated PostgreSQL schema, isolated Hindsight banks, private resumable migration state, and a hard 20-unit bounded sample. No source message body was emitted as migration evidence.

Acceptance evidence:

- cumulative durable migration state: `20` Experience Units processed;
- `2` units entered Memory Intelligence; `18` were explicitly skipped by versioned bounded eligibility rules rather than deleted or silently discarded;
- the resume run processed 10 units with 2 ingestions while the PostgreSQL receipt count moved only `2 -> 3`, demonstrating that one replay reused an existing idempotent receipt instead of creating a duplicate;
- all three persisted distillation receipts are `complete`, with `77`, `73`, and `89` provider units respectively; every receipt has complete curation coverage and `admission_complete=true`;
- one receipt recovered after repeated provider-stage attempts (`attempts=6`) without advancing migration checkpoint prematurely, validating retry/resume behavior;
- the bounded run left `memory_candidates=0`, `memory_heads=0`, and `memory_revisions=0`: conservative governance treated the extracted units as supporting evidence and did not invent canonical truth;
- migration checkpoint is bound to source adapter identity, eligibility-policy version, migration destination identity, and source fingerprint;
- the temporary no-auth Hindsight pilot sidecar was loopback-only and was stopped after acceptance; the normal Hindsight service remained healthy;
- full repository `npm run check` passed after the migration implementation.

This acceptance proves source traversal, normalization, source fingerprint verification, private durable checkpointing, replay/idempotency, Hindsight distillation, curation coverage, deterministic admission, and fail-closed zero-write governance. The bounded sample intentionally produced no admitted canonical candidate, so a separate targeted commit canary was required.

## Canonical commit canary acceptance — 2026-09-13

A targeted canary used a real Hermes session that had already been reviewed in the earlier production pilot as containing durable direct user preferences. The full session remained one Adapter `NormalizedExperience` and was fully archived/provenanced, while Hindsight used the explicit `source_actor_only` Direct Memory Lane. This mode sends only direct user source segments to Memory Intelligence and does not make mixed assistant/tool transcript extraction a prerequisite for canonical user memory. The default Hindsight mode remains `full_plus_source_actor`.

Acceptance evidence:

- source: the same read-only Hermes snapshot, with stable Adapter identity/fingerprint;
- target session: `260` messages / `151` tool calls, while the direct-user projection contained only `13` user rows / approximately `37.6K` characters;
- Hindsight direct-source extraction completed with `115` provider units;
- DLMF curation outcomes: `3` canonical candidates, `4` canonical merges, `1` pending review, and `107` supporting-evidence-only units;
- DLMF committed `3` Canonical Memory IDs while leaving the unresolved unit in `awaiting_review`; the pending review was not auto-approved;
- all `7` candidate provenance checks point back to the Adapter-produced `NormalizedExperience`;
- all `7` committed canonical revisions across those three memories carry matching Adapter Experience provenance;
- raw archive checksum evidence is present;
- replay against the same destination reused the same receipt: `receipts 1 -> 1`, `candidates 7 -> 7`, `heads 3 -> 3`, and `revisions 7 -> 7`;
- replay canary result: `PASS`, with `candidateProvenance=7` and `canonicalProvenance=7`.

This closes the required end-to-end path:

`Hermes snapshot -> HermesSourceAdapter -> NormalizedExperience -> Raw Archive -> Direct Memory Lane -> Hindsight -> Curation -> Governance -> Canonical Memory`

A receipt may legitimately remain `awaiting_review` while already containing governed commits for unambiguous units. Canary success therefore means at least one canonical commit with verified provenance; it does not waive or auto-resolve unrelated pending-review units.

## Requested v1 full-source recovery and replay — 2026-09-13

The originally requested destination was retained rather than replaced:

- schema: `dlmf_pilot_hermes_canonical_canary_v1`;
- namespace: `pilot.hermes-canonical-canary.v1`;
- Hindsight bank prefix: `dlmf-hermes-canonical-canary-v1`;
- reviewed source category: `preference_change`;
- migration fingerprint: `dec15c9e5c361fd1`.

After the 2 GiB Hindsight shared-memory correction, the existing asynchronous full-source operation continued to completion. The DLMF caller that had recorded the earlier ten-minute timeout was no longer active, so an explicit retry reused the same deterministic provider identity and the same DLMF receipt. The receipt advanced from failed attempt `2`, through archived attempt `3`, to an accepted terminal `awaiting_review` state without creating another receipt.

Recovery evidence:

- `processed=1`, `ingested=1`, `skipped=0`;
- `744` provider units and `744` curation decisions with complete curation coverage;
- curation outcomes: `3` canonical candidates, `5` canonical merges, `1` pending review, and `735` supporting-evidence-only units;
- one receipt, `8` candidates, `3` Canonical Memory heads, and `8` revisions;
- all `8` candidate provenance checks point to the Adapter-produced `NormalizedExperience`;
- all `8` canonical revision provenance checks point to the same Adapter experience;
- Hindsight remained healthy with 2 GiB shared memory and returned to zero pending work.

An independent replay state root then forced the same source through the migration runner again while keeping the destination, source, policies, receipt identity, and provider banks unchanged. Replay completed in approximately three seconds and preserved exactly the same receipt, candidate fingerprints, Canonical Memory fingerprints, and canonical truth:

- receipts: `1 -> 1`;
- candidates: `8 -> 8`;
- heads: `3 -> 3`;
- revisions: `8 -> 8`;
- provider units: `744 -> 744`;
- curation decisions: `744 -> 744`;
- candidate provenance: `8 -> 8`;
- canonical revision provenance: `8 -> 8`.

The canonical-write and replay/idempotency canaries pass. The stricter whole-receipt criterion `status=complete`, `canonicalization_outcome=committed`, and `admission_complete=true` remains intentionally open: one durable `user_asserted` preference contradicts an existing semantic target and is held as `merge_required` with `admission:semantic_contradiction_requires_review`. DLMF did not auto-approve or overwrite that conflict. Closing it requires an authorized semantic-review decision bound to the exact pending record; provider completion, more retries, or a new schema cannot supply that authority.

### Direct Memory Lane vs. evidence lane

The commit canary also exposed an operational boundary. A 92K mixed transcript could continue Hindsight processing beyond the former ten-minute provider timeout, while direct user evidence was substantially smaller. DLMF therefore treats these as distinct provider workloads:

- **Direct Memory Lane:** source-actor projection for direct user assertions that can become canonical under governance.
- **Full-source Evidence Lane:** mixed user/assistant/tool context used for supporting evidence and broader extraction. It remains useful but must not block direct user-memory migration.

The complete Experience, provenance, and archive remain source-neutral in both lanes; this split is a Memory Intelligence execution strategy, not an Adapter schema exception.

## Full-source Evidence Chunking acceptance — 2026-09-13

The Full-source Evidence Lane now supports bounded provider-execution chunking without creating new DLMF Experience identities. Chunking is implemented inside the Hindsight Memory Intelligence adapter, not inside `HermesSourceAdapter`. DLMF still archives, fingerprints, checkpoints, governs, and receipts one source `NormalizedExperience`.

Chunk contract:

- chunking is opt-in and version-bound through the migration/distillation policy;
- each chunk has a deterministic provider document ID, content fingerprint, and asynchronous Hindsight operation ID;
- source segments are kept intact when possible; an oversized source segment is deterministically partitioned into bounded fragments;
- `maxChars` and optional `maxSegments` bound every provider operation;
- chunk metadata records only provider-execution identity and fingerprints; it does not become Canonical Memory identity;
- a failed or incomplete chunk prevents the source Experience receipt from reaching an accepted terminal state, therefore the source migration checkpoint does not advance;
- replay uses the same provider operation IDs, so already-completed chunks are reused rather than extracted again.

Executable tests cover bounded payload size, max-segment partitioning, deterministic document/operation identity, replay stability, and isolation from the `source_actor_only` Direct Memory Lane. Repository acceptance after this change: `172` tests, `0` failures (`8` environment-gated skips).

### Live chunk UAT

A real Hermes Experience from the frozen read-only snapshot was run through `full_plus_source_actor` with `maxChars=12000` and `maxSegments=6`. The source remained one Adapter Experience and one DLMF migration checkpoint. Hindsight executed:

- `4` deterministic `full-source:chunk:NNNN:<fingerprint>` documents;
- `1` direct-user source projection;
- all `10` Hindsight operation records (batch + child retain) completed;
- `retry_total=0`, with no provider error;
- DLMF received `79` provider units and `79` curation decisions;
- receipt terminal state: `complete / no_memory_worthy_content`;
- Canonical Memory remained unchanged for this evidence-only sample (`0` candidates, `0` revisions), demonstrating fail-closed governance rather than forced memory creation.

A second DLMF shadow schema then intentionally re-ran the same Experience against the same Hindsight bank, source, policy, and chunk configuration. The run completed in approximately `1.5s` with the same deterministic receipt ID and the same `79` provider units. Hindsight still contained only the original `10` operation records and `retry_total=0`, proving chunk-level provider replay did not create duplicate extraction work.

This closes the chunking requirement while preserving the source-level invariant:

`one source Experience -> one DLMF identity / archive / receipt / checkpoint -> N bounded provider chunks`.

## Stage100 acceptance — 2026-09-13

The first 100-source stage used the frozen snapshot with `full_plus_source_actor`, `maxEvents=80`, `maxChars=60000`, and bounded Full-source Evidence chunks of `12000` characters / `6` source fragments. The deliberately conservative source bounds were selected from a content-free dry-run: exactly `27` of the first `100` Experience Units were eligible for Memory Intelligence and `73` were explicitly skipped by policy.

Acceptance evidence:

- source-level migration: `100 processed / 27 ingested / 73 skipped`;
- PostgreSQL: `27` terminal receipts, `0` provider errors, `970` provider units and `970` curation decisions;
- governance: `3` canonical candidates and `967` supporting-evidence-only decisions;
- canonical state: `3` candidates / `3` heads / `3` revisions, with `3/3` candidate provenance and `3/3` Canonical Memory provenance pointing back to Adapter-produced `NormalizedExperience` evidence;
- receipt outcomes: `2` committed receipts and `25` `no_memory_worthy_content` receipts;
- Hindsight: `196/196` operations completed with `retry_total=0`;
- provider execution: `98` logical retains = `71` bounded full-source chunks + `27` direct-user projections;
- observed child-retain duration: p50 `12.3s`, p90 `69.7s`, max `633.9s`; first-to-last provider wall span approximately `60.9` minutes.

An independent empty migration-state root then replayed the same first 100 Experience Units against the exact same destination, policy, Hindsight banks, and source snapshot. Replay completed in approximately `2.4s`:

- `100 processed / 27 ingested / 73 skipped` were deterministically rediscovered;
- receipts: `27 -> 27`;
- candidates: `3 -> 3`;
- heads: `3 -> 3`;
- revisions: `3 -> 3`;
- Hindsight operations: `196 -> 196`;
- provider retries remained `0`.

This proves source traversal replay, receipt idempotency, chunk-operation reuse, Canonical non-duplication, and provenance closure at the 100-Experience scale.

### Chunk-size tuning

The same real Experience used for the 12K chunk UAT was repeated with `24000` characters / `12` fragments per chunk. The full-source lane dropped from `4` chunks to `2`, plus one unchanged direct-user projection. End-to-end wall time changed only slightly (`330.2s -> 321.6s`), but total Hindsight operation records dropped from `10` to `6`, all with zero retry/error. For larger staged migrations, `24K/12` is therefore the preferred starting point because it reduces provider scheduling/operation pressure without a material latency penalty in the canary.

## Lane separation for 1,000-stage

Stage100 proved that `full_plus_source_actor` is correct, but it also measured the cost of coupling both provider workloads. At the current conservative `80 events / 60K chars` bound, the first 1,000 Experience Units contain `284` eligible full-source sessions. With 12K chunks that would require roughly `515` full-source chunks + `284` user projections; 24K reduces the estimated full-source chunk count to approximately `378`, but the combined lane would still create roughly `662` logical provider retains and inherit long-tail operations.

The 1,000-stage therefore separates execution while preserving one source Experience identity and provenance:

- `source_actor_only` = Direct Memory Lane, allowed to produce governed Canonical Memory;
- `full_source_only` = Full-source Evidence Lane, chunked and intended for mixed/synthesized supporting evidence only;
- `full_plus_source_actor` remains the compatibility/default mode and the already-proven combined-path reference.

`full_source_only` is a Memory Intelligence execution mode, not a Source Adapter exception. It must use bounded full-source chunking in the migration pilot. The complete `NormalizedExperience` remains archived once per receipt and every provider unit still points to the same source Experience.

Repository acceptance after adding the evidence-only lane: `173` tests, `0` failures (`8` environment-gated skips).


### Full-source-only Live canary

A real frozen-snapshot Experience was then run with `distillationProjectionMode=full_source_only` and the selected `24K/12` chunk baseline. Hindsight emitted only two deterministic `full-source:chunk:*` documents and no `source-actor:user` document. Both chunk operations completed with zero retry/error. DLMF received `78` provider units / `78` curation decisions and completed the receipt as `no_memory_worthy_content` with `0` candidates and `0` Canonical revisions, confirming that mixed evidence did not acquire direct-user authority.

An independent replay state root re-ran the same Experience against the same destination in approximately `3.5s`; the receipt count remained `1 -> 1`, Canonical state remained zero, and Hindsight remained exactly `4` operation records (`2` batch parents + `2` retain children), all completed, `retry_total=0`, and `userProjectionOps=0`.

This proves the Full-source Evidence Lane can be scaled independently of the Direct Memory Lane while preserving the same Adapter Experience provenance and fail-closed Canonical boundary.


## Direct Memory Lane Batch250 acceptance and concurrency remediation — 2026-09-13

The first Direct Memory Lane scale batch processed the first `250` source Experience Units against the frozen snapshot using `source_actor_only`, bounded source eligibility (`50` direct-user events / `60K` direct-user characters), DLMF migration lookahead `8`, and Hindsight/Ollama configured for four parallel generation slots (`-np 4`, `65,536` context per slot). Concurrency is an execution parameter only and does not participate in migration identity, so the run resumed the same source checkpoint and destination while the execution width changed.

Durable source-level result:

- `250 processed / 241 ingested / 9 skipped`;
- PostgreSQL destination: `241` receipts, `88` candidate rows, `82` Canonical Memory heads, and `83` revisions;
- receipt outcomes after remediation: `56 complete/committed`, `183 complete/no_memory_worthy_content`, and `2 awaiting_review/pending_review`;
- candidate states: `83 ACCEPTED`, `2 CONFLICT`, `3 PENDING`; only governed accepted candidates contributed Canonical revisions;
- provenance coverage: `88/88` candidate rows and `83/83` canonical revisions retain source-experience provenance;
- Hindsight Direct Lane bank: `482/482` operation records complete = `241` parent batch records + `241` retain children, with `retry_total=0`.

### Ollama throughput correction

Hindsight already allowed bounded concurrent retain work, but Ollama had been launched with `-np 1 -c 262144`, serializing all local Gemma generation. A systemd drop-in changed the runtime to `OLLAMA_NUM_PARALLEL=4` and `OLLAMA_CONTEXT_LENGTH=65536`. The resulting llama-server was verified live as `-np 4 -c 262144`, with the API reporting `65,536` context per slot. After the change, typical source windows improved materially while preserving the same migration identity, receipt IDs, model, and governance policies.

### Canonical-admission retry race

Batch250 exposed two fail-closed canonicalization errors under concurrent retry. The affected curation record IDs are deterministic (`receipt + providerUnitRef`), while candidate IDs are intentionally random. A retry could therefore create a second candidate for a provider unit that had already canonicalized, and the PostgreSQL curation upsert could replace the record's `candidate_id` while retaining the earlier canonical outcome/memory. Canonical Authority correctly rejected the mismatched proof.

The fix preserves the authority boundary rather than relaxing it:

- `TranscriptDistillationService` loads prior curation records for the same receipt before admission;
- a provider unit with an existing canonicalized record is reusable only when provider-unit fingerprint, semantic identity, policy/curator identity, accepted candidate binding, admission verifier, and canonical head scope all still match;
- a valid canonicalized unit is counted/reused directly and no second candidate is created;
- any drift fails closed;
- `PostgresMemoryCurationRecordStore` now preserves both `candidate_id` and `target_memory_id` when an already-canonicalized record receives a retry upsert without a new canonical memory, matching the existing in-memory store's immutability behavior.

A regression test simulates a two-unit receipt where the first unit commits and the second unit fails, then retries the same receipt. The first unit must retain the exact original candidate/canonical binding. Full repository checks pass after the fix.

The two historical rows created before this fix were remediated in one guarded PostgreSQL transaction. Remediation required exactly one revision-backed `ACCEPTED` candidate whose admission proof, provider run, semantic identity, curator identity, and outcome matched each canonicalized curation record. The stale retry candidates had no canonical revision and were changed from `PENDING` to `CONFLICT`; the curation records were rebound to the unique accepted candidates; receipt candidate arrays and terminal admission state were recomputed. Historical error entries were deliberately retained and a remediation warning was added. Post-remediation dry-run reports `repairsNeeded=0` and both receipts recompute to `complete / committed / admissionComplete=true`.

An isolated PostgreSQL schema UAT additionally proved that an already-canonicalized curation record retains its original candidate ID, canonical memory ID, outcome, semantic relation, target, and audit reason codes when a retry attempts to upsert the same record with a different candidate. The ephemeral schema was dropped after the assertion.


## Direct Memory Lane Batch500 acceptance — 2026-09-13

The Direct Memory Lane then continued over source positions `251-500` using the exact same frozen snapshot, migration identity, PostgreSQL destination, Hindsight bank prefix, `source_actor_only` policy, direct-user eligibility bounds (`50` user events / `60K` user characters), lookahead `8`, and the four-slot Ollama runtime. No new source or memory identity was created when the execution bridge restarted; the source-level state file remained authoritative and the run resumed from its durable checkpoint.

Cumulative acceptance at source position `500`:

- `500 processed / 480 ingested / 20 skipped`;
- PostgreSQL: `480` receipts, `112` candidate rows, `106` Canonical Memory heads, and `107` revisions;
- receipt outcomes: `78 complete/committed`, `400 complete/no_memory_worthy_content`, `2 awaiting_review/pending_review`;
- candidate states: `107 ACCEPTED`, `2 CONFLICT` (the preserved pre-fix audit rows), and `3 PENDING` review-path candidates;
- provenance: all `112` candidate rows and all `107` canonical revisions retain source-experience provenance;
- Hindsight: `960/960` operation records completed = `480` retain children + `480` batch parents, `retry_total=0`;
- canonical-admission binding monitor remained fixed at the two already-remediated historical receipts; no new mismatch was observed after commit `25dc16c`.

An independent empty migration-state root replayed source positions `1-500` against the same destination, policies, Hindsight bank, and frozen snapshot. Replay deterministically rediscovered `500 / 480 / 20` while preserving:

- receipts `480 -> 480`;
- candidates `112 -> 112`;
- heads `106 -> 106`;
- revisions `107 -> 107`;
- Hindsight operations `960 -> 960`, all completed, `retry_total=0`;
- canonical-admission remediation dry-run remained `repairsNeeded=0`.

This closes the Direct500 gate and proves that source checkpoint recovery is independent of the AEB job-tracking process, while receipt/canonical/provider identities remain replay-safe at 500-source scale.

## Direct Memory Lane Batch750 acceptance — 2026-09-13

The Direct Memory Lane continued over source positions `501-750` with the same frozen snapshot, migration fingerprint, PostgreSQL destination, Hindsight bank, `source_actor_only` policy, direct-user bounds (`50` user events / `60K` user characters), lookahead `8`, and four-slot Ollama runtime.

Cumulative acceptance at source position `750`:

- `750 processed / 537 ingested / 213 skipped`;
- the skip distribution is deterministic and policy-explainable: `199` `hermes_empty_session` and `14` `bounded_direct_source_char_limit`; an independent Adapter+policy scan reproduced exactly `537 / 213`;
- PostgreSQL: `537` receipts, `120` candidate rows, `114` Canonical Memory heads, and `115` revisions;
- receipt outcomes: `84 complete/committed`, `451 complete/no_memory_worthy_content`, and `2 awaiting_review/pending_review`;
- candidate states: `115 ACCEPTED`, `2 CONFLICT` retained as pre-fix audit history, and `3 PENDING` review-path candidates;
- provenance coverage: `120/120` candidate rows and `115/115` canonical revisions retain source-experience provenance;
- Hindsight: `1074/1074` operation records completed = `537` retain children + `537` batch parents, with `retry_total=0`;
- the canonical-admission remediation dry-run remains `repairsNeeded=0`; no new retry-binding drift occurred after the fix.

An independent empty migration-state root replayed source positions `1-750` against the exact same destination, policy, bank, and frozen snapshot. Replay deterministically rediscovered `750 processed / 537 ingested / 213 skipped` while preserving:

- receipts `537 -> 537`;
- candidates `120 -> 120`;
- heads `114 -> 114`;
- revisions `115 -> 115`;
- Hindsight operations `1074 -> 1074`, all completed, `retry_total=0`;
- canonical-admission remediation dry-run `repairsNeeded=0`.

This closes the Direct750 gate. The large skip increase in positions `501-750` is source-distribution driven (mostly empty Hermes sessions), not policy drift or lost experience.

## Direct Memory Lane Direct1000 acceptance — 2026-09-13

The Direct Memory Lane completed source positions `751-1000` without changing the frozen source snapshot, migration fingerprint, PostgreSQL destination, Hindsight bank, `source_actor_only` policy, direct-user eligibility bounds (`50` events / `60K` characters), lookahead `8`, Gemma model, or Canonical governance policy.

The deterministic Adapter+eligibility scan predicted exactly `576` eligible and `424` skipped Experience Units in the first 1,000 sources. The completed migration matched that prediction exactly:

- `1000 processed / 576 ingested / 424 skipped`;
- skip distribution: `400` `hermes_empty_session` and `24` `bounded_direct_source_char_limit`;
- PostgreSQL: `576` receipts, `123` candidate rows, `117` Canonical Memory heads, and `118` revisions;
- receipt outcomes: `87 complete/committed`, `487 complete/no_memory_worthy_content`, and `2 awaiting_review/pending_review`;
- candidate states: `118 ACCEPTED`, `2 CONFLICT` retained as the pre-fix retry-race audit trail, and `3 PENDING` review-path candidates;
- candidate classes: `122` user-asserted preferences and `1` user-asserted habit candidate row;
- provenance closure: `123/123` candidate rows and `118/118` Canonical revisions retain source-experience provenance;
- Hindsight Direct Lane bank: `1152/1152` operations completed = `576` retain children + `576` batch parents, `retry_total=0`;
- canonical-admission remediation remains stable at `repairsNeeded=0`; no post-fix binding drift was detected.

An independent empty migration-state root replayed source positions `1-1000` against the same destination, policies, bank, source snapshot, and provider identity. Replay deterministically rediscovered `1000 / 576 / 424` while preserving:

- receipts `576 -> 576`;
- candidates `123 -> 123`;
- heads `117 -> 117`;
- revisions `118 -> 118`;
- Hindsight operations `1152 -> 1152`, all completed with `retry_total=0`;
- admission remediation dry-run `repairsNeeded=0`.

This closes the Direct1000 gate. Direct user-memory extraction is now proven source-resumable, receipt-idempotent, provider-replay-safe, Canonical-nonduplicating, and provenance-closed at 1,000-source scale.

## Reviewed canonical-commit closure — 2026-09-13

The retained full-source canonical-canary destination was closed after the Owner made
a bounded semantic decision for its one contradictory preference unit. DLMF consumed
the durable `invalid_candidate` decision through an exact source, content-hash,
semantic-key, relation, and Canonical-target binding. Provider execution identity was
not allowed to redefine the reviewed proposition, and any semantic/content/target
drift still fails closed.

The strict retry completed one real Adapter Experience with `744/744` provider and
curation coverage: `735` supporting-evidence-only units, `8` governed canonical
merges, `1` reviewed rejection, and `0` pending review. The receipt reached
`complete / committed`, exposed `8` candidate IDs and `3` Canonical Memory IDs,
and passed candidate plus current-revision provenance checks back to the same
`NormalizedExperience`.

An exact source replay produced no new receipt, candidate, head, or revision
(`3/24/3/24` remained `3/24/3/24`) and preserved the Canonical truth fingerprint.
The earlier fail-closed receipt and review evidence remain append-only. See
[DLMF-SG-011](dlmf-sg-011-hermes-canonical-canary-review-remediation.md) for the
governance contract and complete verification record.

## Full-source Evidence Lane Batch250 acceptance — 2026-09-13

The Full-source Evidence Lane processed source positions `1-250` against the same frozen Hermes snapshot using `full_source_only`, conservative full-source eligibility (`80` events / `60K` characters), bounded `24K/12` provider chunks, migration lookahead `8`, and the four-slot Ollama runtime. This lane is evidence-only: provider units may support memory governance, but mixed transcript evidence is not permitted to acquire direct-user Canonical authority.

Durable source-prefix result:

- `250 processed / 78 ingested / 172 skipped`;
- source positions `1-250` contain exactly `78` DLMF receipts, and all `78/78` are `complete / no_memory_worthy_content`;
- `2,516` provider units received exactly `2,516` curation decisions;
- every admitted evidence unit remained `supporting_evidence_only`; PostgreSQL contains `0` candidates, `0` Canonical Memory heads, and `0` revisions in the Evidence destination;
- the first-250 provider prefix contains `252/252` completed Hindsight operation records across `126` deterministic chunk documents, with `retry_total=0`;
- the dominant curation classes are synthesized mixed-speaker general, technical, project, event, and transient evidence; even provider-labelled mixed preferences remain supporting evidence and cannot become Canonical Memory.

An independent empty migration-state root replayed source positions `1-250` against the same PostgreSQL destination, Hindsight bank, source snapshot, policy versions, and chunk policy. Replay completed without creating new receipts, Canonical state, or provider work. A second independent replay was used to make the provider assertion source-position scoped: Hindsight remained exactly `252` operation records / `126` chunk documents for positions `1-250`, all completed with `retry_total=0`; PostgreSQL remained exactly `78` terminal prefix receipts and zero Canonical state.

Three speculative receipts were observed outside the accepted prefix at source positions `252`, `253`, and `257`. They were created by earlier interrupted/concurrent lookahead work, were not counted as durable Batch250 progress, and are explicitly owned by Batch2. Prefix acceptance therefore uses Adapter source position rather than global destination row count, preventing valid next-batch work from contaminating the Batch250 gate.

### Evidence chunk throughput observation

The `24K/12` policy substantially reduces provider operation count compared with `12K/6`, and the earlier same-Experience A/B remained essentially equal in total wall time (`321.6s` vs `330.2s`). Batch250 nevertheless confirmed a pronounced local-model long tail: completed evidence retains showed roughly p50 `52.8s`, p90 `160.7s`, with individual operations extending beyond ten minutes while continuing to emit healthy Hindsight heartbeat/storing progress. Because the same-Experience A/B did not show a 12K wall-time advantage, Batch2-4 retain `24K/12`; long-tail behavior is treated as a provider/model throughput characteristic rather than evidence that Source identity or checkpointing is stalled.

This closes the Evidence250 gate: mixed full-source evidence is source-resumable, chunk-operation replay-safe, provenance-preserving, and unable to bypass Canonical Memory authority.

## Full-source Evidence Lane Batch500 acceptance — 2026-09-13

The Evidence Lane continued through source position `500` without changing the frozen snapshot, destination, Hindsight bank, `full_source_only` policy, conservative `80 events / 60K characters` eligibility bounds, or `24K/12` chunk policy. The deterministic eligibility scan predicted Batch2 (`251-500`) as `156` eligible / `94` skipped, and the durable run matched exactly.

Cumulative Evidence500 acceptance:

- `500 processed / 234 ingested / 266 skipped`;
- prefix positions `1-500` contain exactly `234` receipts and all `234/234` are `complete / no_memory_worthy_content`;
- `5,626` provider units received exactly `5,626` curation decisions;
- mixed evidence produced `0` candidates, `0` Canonical Memory heads, and `0` revisions;
- the Hindsight prefix contains `720/720` completed operation records across `360` deterministic chunk documents, with `retry_total=0`;
- an independent empty-state replay rediscovered `500 / 234 / 266` in approximately six seconds while preserving receipts `234 -> 234`, candidates `0 -> 0`, heads `0 -> 0`, revisions `0 -> 0`, and the exact `720 / 360` provider prefix.

Batch2 also exposed an execution-governance issue rather than a memory-governance issue: two migration processes were briefly allowed to target the same durable state before the duplicate writer failed closed. No checkpoint or Canonical truth crossed the failure boundary, but the incident demonstrated that downstream receipt idempotency is not a substitute for source-state single ownership. Commit `a8e39a4` therefore adds a PostgreSQL session-level advisory lock bound to the migration destination identity. New migration applies now fail fast before source traversal when another writer owns the same destination; the lock is automatically released when the database session ends. Full repository checks passed before promotion of this hardening.

This closes the Evidence500 gate and establishes both evidence replay safety and explicit single-writer ownership before scaling the same destination further.

## Full-source Evidence Lane Batch750 acceptance — 2026-09-14

The Full-source Evidence Lane completed source positions `501-750` against the same frozen snapshot, PostgreSQL destination, Hindsight bank, `full_source_only` policy, `24K/12` chunk policy, and bounded lookahead. Source-position-scoped acceptance proved:

- cumulative source progress through position `750` is complete;
- positions `1-750` contain `266/266` terminal DLMF receipts, all `complete / no_memory_worthy_content`;
- `6,479` provider units received exactly `6,479` curation decisions;
- Evidence destination Canonical state remains `0` candidates / `0` heads / `0` revisions;
- Hindsight prefix contains `812/812` completed operation records across `406` deterministic chunk documents, with `retry_total=0`;
- no mixed full-source evidence acquired direct-user Canonical authority.

The durable migration later advanced to position `764`. Source-position inspection showed this is not a Batch750 replay or boundary failure: position `758` had already completed normally, position `765` remained an archived receipt with its deterministic Hindsight retain still processing, and position `771` had completed speculatively in a later lookahead. Therefore position `750` is a clean accepted prefix and later receipts are owned by the `751-1000` stage.

This closes the Evidence750 gate.

## Full-source Evidence Lane Evidence1000 acceptance — 2026-09-14

The Full-source Evidence Lane completed source positions `751-1000` without changing the frozen snapshot, PostgreSQL destination, Hindsight bank, `full_source_only` policy, conservative `80 events / 60K characters` eligibility bounds, `24K/12` chunk policy, or Canonical governance boundary. The single-writer advisory lock was acquired for the final bounded run and released with its database session.

The deterministic Adapter+eligibility scan predicted exactly `284` eligible and `716` skipped Experience Units in the first 1,000 source positions. Durable migration matched that prediction exactly:

- `1000 processed / 284 ingested / 716 skipped`;
- all `284/284` receipts are `complete / no_memory_worthy_content`, with zero duplicate logical receipt groups and zero incomplete curation coverage;
- `7,721` provider units received exactly `7,721` curation decisions;
- every receipt is bound to a non-empty Adapter `NormalizedExperience` source ID and raw archive checksum, and every curation record resolves to the same receipt/source binding;
- mixed evidence produced `0` candidates, `0` Canonical Memory heads, and `0` revisions, so no full-source provider output acquired direct-user Canonical authority;
- the Hindsight bank contains `892/892` completed operation records across `446` deterministic chunk retains, with `retry_total=0`.

An independent empty migration-state root replayed source positions `1-1000` against the exact same source, destination, policy versions, bank, and provider identities. Replay completed in approximately `7.7s` and deterministically rediscovered `1000 / 284 / 716` while preserving:

- receipts `284 -> 284` and the complete receipt-state fingerprint;
- provider units and curation decisions `7,721 -> 7,721`;
- candidates / heads / revisions `0 / 0 / 0 -> 0 / 0 / 0`;
- Hindsight operations `892 -> 892`, all completed with the same operation-state fingerprint and `retry_total=0`;
- zero duplicate receipt groups, provenance mismatches, or curation-coverage gaps.

The bounded migration state reports `complete=false` because the acceptance target is the first 1,000 source positions, not exhaustion of the 11,269-session snapshot. This is expected and does not weaken the closed Evidence1000 prefix.

### Direct vs Evidence provider behavior

At 1,000-source scale, the Direct Lane created `576` logical retains / `1,152` operation records, while the Evidence Lane created `446` logical chunk retains / `892` operation records. Both had zero provider retries. Completed child-retain durations show the expected full-source cost:

- Direct Lane: p50 `35.0s`, p90 `151.9s`, max `917.4s`;
- Evidence Lane: p50 `56.4s`, p90 `248.3s`, max `1,039.2s`.

The observed first-to-last operation spans include deliberate pauses between staged runs and are not treated as pure runtime benchmarks. The comparable per-retain distribution still demonstrates that mixed full-source context has a materially heavier long tail. Lane separation therefore remains the correct operational design: Direct Memory can progress under DLMF governance without waiting for slower evidence extraction, while Evidence remains supporting provenance rather than Canonical authority.

This closes the Evidence1000 gate. Full-source mixed evidence is source-resumable, receipt-idempotent, chunk-operation replay-safe, provenance-closed, curation-complete, and unable to create unintended Canonical Memory at 1,000-source scale.

## Full snapshot sizing and throughput optimization closure — 2026-09-14

A read-only scan over the complete frozen Hermes snapshot (`11,269` sessions) was used to size the remaining historical migration without invoking Hindsight or writing memory state. Under the already accepted conservative policies:

- Direct Memory Lane: `9,029` eligible / `2,240` skipped. Skip reasons are `1,823` empty sessions, `315` direct-user event-limit, `100` direct-user character-limit, `1` hidden session, and `1` session with no user text.
- Full-source Evidence Lane: `4,506` eligible / `6,763` skipped. Skip reasons are `1,823` empty sessions, `3,012` event-limit, `1,927` character-limit, and `1` hidden session.
- Evidence `24K/12` chunking would create `6,185` deterministic provider chunks (`3,432` one-chunk Experiences, `640` two-chunk, `294` three-chunk, `115` four-chunk, `20` five-chunk, `4` six-chunk, and `1` seven-chunk Experience).
- Direct user-only text grows from `1,856,163` characters in the first 1,000 sources to `37,038,289` characters over the full snapshot. Evidence rendered chunk text grows from `3,662,495` to `61,108,850` characters. Full migration therefore cannot be costed accurately from session count alone.

Several proposed throughput shortcuts were tested against real accepted Canonical outcomes and rejected because memory recall has priority over speed:

1. Deterministic durable-language gate: selected roughly `27%` of Direct1000 sources but recovered only `52/89` known accepted-source labels (`58.4%` recall).
2. Qwen3 Embedding 8B semantic gate: five-fold holdout recall was `87/89` (`97.75%`) while still selecting roughly `77%` of Direct sources. Union with the deterministic gate still missed the same two known Canonical-positive sources; it is therefore not allowed to auto-skip Hindsight.
3. Qwen3.8:27b retain backend: a same-source A/B measured Qwen retain at approximately `317.7s` versus Gemma at `11.8s`. A second warm tiny-source canary completed Qwen in about `18.3s`, but Qwen produced `0` Canonical Memory where Gemma produced a governed Canonical preference. The alternate retain model is therefore rejected for both throughput instability and recall degradation.
4. Gemma `np8 × 32K`: an isolated Ollama/Hindsight runtime proved true `-np8` execution and completed the same eight real Direct sources with `retry_total=0` in `133.327s` wall time, with median child-retain latency `124.2s`. A clean `np4 × 64K` run over the same eight sources completed in `128.613s` with median latency `90.6s`; one transient Ollama connect failure retried successfully, yet the `np4` batch still finished faster. The experiment therefore rejects `np8`: GPU contention raises per-request latency enough to erase the extra parallelism.
5. Hindsight direct-source `dry_run`: the matched 20-source A/B recovered only `7/10` retain-positive sources (`70%` recall), despite `0/10` false positives; median execution was about `14.7s`. It is useful as an extraction diagnostic, but it is not a safe replacement or auto-skip gate for retained Direct extraction.

The accepted historical-migration provider baseline remains **Gemma4:26b, Ollama `np4`, 64K context per slot, Hindsight retained `source_actor_only` extraction**. Performance optimization must not lower known Canonical recall.

Operationally, full Direct migration has priority over full Evidence backfill. Under the current accepted policy, Full-source Evidence is synthesized/mixed and cannot create Canonical Memory; its first 1,000-source gate already proves the lane's replay/provenance boundary. Deferring the remaining Evidence backfill does not delete source experience or change Canonical authority: the frozen source and raw/archive contracts remain available for later evidence materialization.

## Clean Direct1000 Shadow v3 acceptance — 2026-09-14

The original `dlmf_pilot_hermes_adapter_direct1000_v1` destination passed its historical 1,000-source acceptance gate, but later replay/identity experiments contaminated that physical pilot schema after acceptance. Its current forensic state is `756` receipts over `576` distinct sources, `191` candidate rows (`180` accepted), `117` heads, and `180` revisions. It must not be used as the continuation destination for full historical migration.

A clean replacement destination, `dlmf_pilot_hermes_adapter_direct1000_shadow_v3`, was rebuilt from the same frozen snapshot, Direct namespace, policy versions, and existing Hindsight Direct bank. The provider bank already contained all first-1,000 deterministic retains, so the rebuild performed no new model extraction (`1,152/1,152` existing Hindsight operations remained completed, `retry_total=0`). The clean source result is:

- `1000 processed / 576 ingested / 424 skipped`;
- exactly `576` receipts over `576` distinct source Experiences;
- receipt outcomes: `87 complete/committed`, `487 complete/no_memory_worthy_content`, and `2 awaiting_review/pending_review`, with zero receipt errors;
- `119` candidate rows: `118 ACCEPTED`, `1 CONFLICT`, and `0 PENDING` candidate rows;
- accepted candidate classes: `117` user preferences and `1` user habit;
- `117` Canonical heads and `118` revisions;
- provenance closure: `119/119` candidate rows and `118/118` revisions retain source-experience provenance.

An independent empty-state replay of the clean shadow completed in approximately `8.1s` and preserved receipts `576 -> 576`, candidates `119 -> 119`, heads `117 -> 117`, revisions `118 -> 118`, and Hindsight operations `1,152 -> 1,152`. No new provider work or Canonical state was created.

`direct1000_shadow_v3` is therefore the accepted continuation baseline for source positions `1001+`. The contaminated v1 schema remains forensic evidence only; it is not deleted and is not Canonical authority.

## Direct Phase-1 continuation through source position 1200 — 2026-09-14

The clean shadow-v3 Direct Lane continued from `1000` through source position `1200` under the original Direct source-evidence contract. The accepted Phase-1 checkpoint is:

- `1200 processed / 617 ingested / 583 skipped`;
- positions `1001-1200` created `41` receipts: `40 complete/no_memory_worthy_content` and `1 complete/committed`;
- those receipts contained `591` provider units and exactly `591` curation decisions;
- the accepted cumulative Canonical state before the later contract-transition replay was `617` receipts, `120` candidate rows, `118` Canonical heads, and `119` revisions;
- all `120/120` candidate rows and `119/119` revisions retained source-experience provenance.

The Phase-1 durable state is frozen at source position `1200`. It remains the reviewed predecessor checkpoint for later migration contracts; it must not be silently reused under a changed Source Evidence or policy contract.

## Source Evidence contract transition and forensic preservation — 2026-09-14

Later source-adapter hardening preserved previously omitted tool-only evidence in `NormalizedExperience.sourceSegments`. That change is correct source preservation, but the historical migration identity did not yet include a Source Evidence contract or the policy bundle. A replay of positions `1001-1200` therefore reused the Phase-1 migration fingerprint while computing new receipt idempotency keys from the enriched segments.

The transition replay produced exactly `40` duplicate receipts and one equivalent Canonical merge. Forensic verification proved that this was identity drift rather than new Canonical truth:

- every new receipt had an older receipt for the same source Experience;
- the single new candidate was an `ACCEPTED` equivalent preference merge into an existing memory;
- revision `2` of that memory has exactly the same canonical text, content hash, semantic fingerprint, and semantic key as revision `1`;
- the new revision only adds a second raw-archive/source-evidence reference;
- there were no conflicts, semantic-review decisions, insight promotions, or provider materializations;
- the outbox row for commit `120` remained `PENDING` with `attempts=0`, and there were no device checkpoints acknowledging it.

A destructive physical cleanup was intentionally not forced through the execution-policy boundary. The transition records remain append-only forensic evidence. They are not treated as an independent life history, and the Canonical head identity did not change. Phase-1 is therefore frozen at the reviewed source checkpoint rather than retroactively pretending the evidence contract never changed.

## Hermes Historical Migration Contract v2 — 2026-09-14

Migration execution identity is now explicitly policy-bound. Branch `fix/hermes-migration-contract-identity-v2` contains commits `03957e7` and `f89c724`, both pushed to the remote branch. The contract binds the migration fingerprint to:

- `sourceEvidenceContractVersion`;
- distillation policy version;
- Canonical governance policy version;
- admission policy identity;
- retention policy version;
- curation provider version;
- semantic policy version;
- existing source selection, Hindsight bank, projection mode, chunking, scope, runtime, and eligibility identity.

Direct retain under the new Source Evidence contract uses `hermes-migration-pilot-distill-v7-source-actor-only:normalized-experience-source-evidence-v2`. Preflight against the same Phase-1 schema/bank/state root produces a new migration fingerprint instead of treating the old state as resumable; changing only the Source Evidence contract version changes the fingerprint again.

Contract v2 also adds a controlled successor-state path. A successor may inherit only the validated Adapter checkpoint and cumulative source counters from a non-exhausted predecessor; the new state receives the new migration identity. Preflight is read-only and reports `successor-ready`; apply atomically materializes the successor state before continuing. This creates an auditable boundary between processing contracts without restarting the person's history or rebuilding existing Canonical Memory.

## Direct Phase-2 gate: source positions 1201-1300 — 2026-09-14

Phase-2 continues from the frozen Phase-1 source checkpoint while sharing the same PostgreSQL Canonical store and namespace. It uses a new Hindsight bank, new migration state/archive roots, Source Evidence contract v2, and the policy-bound migration identity. The initial read-only sizing predicted exactly `24` eligible / `76` skipped sources, and the durable run matched exactly:

- successor cumulative state: `1300 processed / 641 ingested / 659 skipped`;
- Phase-2 delta: `100 processed / 24 ingested / 76 skipped`;
- `24/24` Phase-2 receipts are terminal: `3 complete/committed` and `21 complete/no_memory_worthy_content`;
- `463` provider units received exactly `463` curation decisions;
- Phase-2 created `3` governed Canonical memories: `2` user-asserted preferences and `1` user-asserted habit;
- candidate provenance `3/3` and Canonical revision provenance `3/3` point back to the Adapter Experiences;
- the Phase-2 Hindsight bank contains `48/48` completed operations = `24` retain children + `24` batch parents, with `retry_total=0`.

A second successor state, seeded independently from the same Phase-1@1200 predecessor, replayed positions `1201-1300` and preserved the physical destination exactly: receipts `681 -> 681`, candidates `124 -> 124`, heads `121 -> 121`, revisions `123 -> 123`, and Hindsight operations `48 -> 48`. The Phase-2 gate is therefore source-resumable, provider-idempotent, Canonical-nonduplicating, provenance-closed, and contract-versioned.

## Direct Phase-2 gate: source positions 1301-1500 — 2026-09-14

Phase-2 continued under the exact same Contract v2 identity established at source position `1200`: Source Evidence contract `normalized-experience-source-evidence-v2`, policy fingerprint `ad74a049c4548676`, migration fingerprint `7760a46680a499ae`, `source_actor_only + retain`, `50` user events / `60K` user characters, Gemma4:26b, Ollama `np4 × 64K`, bounded concurrency `8`, and the single-writer advisory lock.

The deterministic Adapter+eligibility scan predicted positions `1301-1500` as `43` eligible / `157` skipped. Durable execution matched exactly and advanced the successor state from `1300` to `1500`, yielding cumulative successor counters `1500 processed / 684 ingested / 816 skipped`.

Phase-2 acceptance through source position `1500` is:

- `67` Contract-v2 receipts over `67` distinct source Experiences;
- receipt outcomes: `8 complete/committed`, `57 complete/no_memory_worthy_content`, and `2 awaiting_review/pending_review`;
- `1,314` provider units received exactly `1,314` curation decisions;
- the Contract-v2 path created `10` candidate IDs / `10` Canonical Memory IDs, with `10/10` candidate provenance and `10/10` Canonical revision provenance back to `NormalizedExperience`;
- curation admitted `9` direct-user preference candidates and `1` direct-user habit candidate, while general, technical, project, event, and transient units remained supporting evidence;
- the Phase-2 Hindsight bank contains `134/134` completed operation records = `67` retain children + `67` batch parents, with `retry_total=0`.

The independent successor replay state first closed `1201-1300`, then replayed positions `1301-1500` with the same Phase-1 predecessor and Contract-v2 fingerprint. The latter replay rediscovered `200 processed / 43 ingested / 157 skipped` while preserving receipts `724 -> 724`, candidates `131 -> 131`, heads `128 -> 128`, revisions `130 -> 130`, and Hindsight operations `134 -> 134`. No provider extraction or Canonical state was duplicated.

This closes the Direct1500 gate and proves that a policy-bound successor migration can continue an existing Digital Life across a Source Evidence contract boundary without restarting source history, reusing an invalid checkpoint identity, or duplicating Canonical Memory.

## Next increment

1. Continue Direct Phase-2 from the accepted source position `1300` successor checkpoint using the unchanged frozen snapshot, Source Evidence contract v2, policy-bound migration identity, `source_actor_only + retain`, `50` user-event / `60K` user-character bounds, Gemma4:26b, Ollama `np4 × 64K`, bounded concurrency, and the single-writer advisory lock.
2. Before every larger prefix, run a read-only sizing pass. Continue in independently accepted bounded gates and require receipt/provider replay, Canonical non-duplication, provenance closure, and fail-closed checkpoints.
3. Do not authorize deterministic, embedding, Qwen-classifier, or Hindsight dry-run auto-skips: every tested shortcut missed known Canonical-positive sources. They may only prioritize work, never remove Experiences from Canonical-capable processing.
4. Keep the Full-source Evidence lane deferred after the closed Evidence1000 gate unless an explicit operational need requires supporting evidence sooner. The frozen source/raw archive preserves the ability to backfill it later.
5. Treat Phase-1 transition rows as forensic audit history; do not physically delete them merely to make counters prettier. Canonical truth is governed by heads/revisions, not by erasing execution history.
6. Design mutable-session change detection before claiming full live incremental synchronization; `incrementalSync` remains `partial`, and deletion detection remains `unknown`.
7. Keep historical migration completion, Digital-Life-Stack activation, hosted CI/merge, production scheduling, credentials, retention, and rollback as separate operational gates.
