# DLMF-ADAPTER-001 — Hermes Source Adapter

**Date:** 2026-09-12
**Status:** Live Snapshot UAT PASS — bounded migration / canonical-write / replay / full-source chunking PASS; 100-Experience stage pending
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

## Next increment

1. Replay the first `250` Direct Memory Lane sources from an independent empty migration-state root against the same destination/banks and require zero receipt/head/revision/operation growth.
2. Continue the Direct Memory Lane over sources `251-500`, then `501-750`, then `751-1000` using the same migration identity, bounded lookahead, and four-slot Ollama runtime; stop on any new fail-closed admission inconsistency.
3. After the Direct1000 replay/provenance gate passes, run the Full-source Evidence Lane over the same first 1,000 sources in resumable batches using `full_source_only` and the selected `24K/12` chunk baseline.
4. Compare direct/evidence throughput and long-tail provider behavior before increasing beyond 1,000 or widening source eligibility bounds.
5. Keep live incremental synchronization separate; `incrementalSync` remains `partial` until mutable-session change detection is designed.
