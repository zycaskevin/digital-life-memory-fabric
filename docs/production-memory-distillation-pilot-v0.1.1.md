# DLMF v0.1.1 — Nancy Production Memory Distillation Pilot

**Date:** 2026-09-03  
**Status:** Runner implemented; GB10 host apply required  
**Scope:** Five real completed Nancy/Hermes sessions only  
**Pruning:** Forbidden during pilot

## Goal

Validate the v0.1.1 Memory Distillation amendment against real Nancy data without
changing Nancy's production canonical truth or deleting any Hermes history.

The pilot samples exactly five distinct completed sessions:

1. ordinary conversation;
2. technical/debugging conversation;
3. long project conversation;
4. preference-change conversation;
5. conversation containing inferred/reflective insight.

The runner uses deterministic heuristics to select one candidate per category from
recent completed sessions and writes a private manifest for review.

## Safety topology

```text
production Hermes state.db
        |
        | read-only SQLite snapshot transaction
        v
five completed sessions
        |
        v
pilot filesystem raw archive
        |
        v
pilot Hindsight distillation bank
        |
        v
pilot DLMF PostgreSQL schema
  namespace = pilot.memory-distillation.v0.1.1
        |
        +--> pilot canonical projection bank
        +--> reflective candidate test
        +--> prune eligibility evaluation only

NO Hermes write
NO Hermes delete
NO production Hindsight bank write
NO life.core write
```

The runner refuses `--apply` unless:

- namespace starts with `pilot.`;
- PostgreSQL schema starts with `dlmf_pilot_`;
- both Hindsight banks contain `pilot` and are distinct;
- `DLMF_PILOT_DATABASE_URL` is explicitly supplied.

## Runner

```text
scripts/production-pilot/memory-distillation-pilot.mjs
```

Package command:

```bash
npm run pilot:memory-distillation
```

Without `--apply`, the command is plan-only. It opens Hermes SQLite in `readOnly`
mode, selects five sessions, and writes only the private manifest.

## GB10 host preflight

Run this from the real GB10 host shell, not the CatDesk container:

```bash
cd /path/to/digital-life-memory-fabric
git pull --ff-only
npm ci
npm run check

hermes config path
hermes memory status
```

For local Hindsight, verify the configured service is healthy. Hermes local embedded
and local external modes normally use `http://localhost:8888` unless overridden by
`~/.hermes/hindsight/config.json`.

The runner reads the Hindsight mode/URL/API key from the Hermes Hindsight config
without printing credentials. Environment overrides are supported.

## Step 1 — plan against production Hermes, no external writes

```bash
HERMES_HOME="$HOME/.hermes" \
DLMF_PILOT_HERMES_DB="$HOME/.hermes/state.db" \
npm run pilot:memory-distillation
```

Expected terminal marker:

```ini
PILOT_PLAN=PASS
```

The manifest is written under:

```text
~/.local/state/dlmf/production-pilot/
```

with file mode `0600`.

Review that all five categories are reasonable before apply. `selection=fallback`
means the heuristic could not find a strong semantic match and the session should
be manually reviewed before continuing.

## Step 1.25 — bootstrap isolated DLMF PostgreSQL

If preflight reports `DLMF_PILOT_DATABASE_URL_NOT_CONFIGURED`, create an isolated
local embedded PostgreSQL for DLMF pilot state:

```bash
npm run pilot:memory-distillation:bootstrap-postgres
```

The bootstrap uses a separate port-specific pg0 instance such as
`dlmf-pilot-v011-55433`, starting from local port `55432`, with database/user
`dlmf_pilot` and a generated password. If the requested port is occupied, it
automatically selects the next free localhost port. The password
is never printed. The connection URL is stored in:

```text
~/.config/dlmf/production-pilot.env
```

with mode `0600`. The pilot runner automatically reads this private file when
`DLMF_PILOT_DATABASE_URL` is not supplied explicitly. This is a different
PostgreSQL instance from Hindsight's provider storage.

Expected marker:

```ini
DLMF_PILOT_PG0_BOOTSTRAP=PASS
```

The bootstrap normally handles local port collisions automatically. An explicit
starting port is still available when needed:

```bash
DLMF_PILOT_PG_PORT=56000 npm run pilot:memory-distillation:bootstrap-postgres
```

Credentials and the selected instance/port are persisted **before** PostgreSQL is
started, so an interrupted bootstrap can be safely retried without losing the
cluster password.

## Hindsight tenant authentication

For `local_external`, Hermes may store `HINDSIGHT_API_KEY` in
`$HERMES_HOME/.env` rather than `hindsight/config.json`. The pilot reads the same
credential sources and performs a **read-only** `GET /v1/default/banks?limit=1`
probe before Apply. It tries explicit pilot override, Hermes env key, Hindsight config
key, then unauthenticated access, deduplicating identical keys. Only a strategy that
passes the bank API may be used for Apply. Preflight prints the selected auth source
and a short SHA-256 fingerprint, never the secret itself.

## Step 1.5 — infrastructure preflight

After the five-session plan passes, run the read-only infrastructure preflight:

```bash
HERMES_HOME="$HOME/.hermes" \
DLMF_PILOT_HERMES_DB="$HOME/.hermes/state.db" \
OMNIHARNESS_DIR='/path/to/OmniHarness' \
npm run pilot:memory-distillation:preflight
```

The preflight checks the real Hermes sample, Hindsight mode/health/auth/version, whether
DLMF PostgreSQL is configured (environment or private bootstrap file), performs a
real read-only `SELECT 1` connectivity probe, and reports local PostgreSQL clues. It prints no database password or Hindsight API key and creates no
schema or memory. A blocked preflight exits with status 2 and emits explicit
`BLOCKER=...` markers.

Expected before apply:

```ini
PRODUCTION_PILOT_PREFLIGHT=PASS
```

## Step 2 — apply to isolated pilot stores

Apply must be pinned to the exact Plan manifest that was reviewed. The runner reloads
only those five Hermes session IDs and recomputes each transcript SHA-256. If any
transcript changed after Plan, Apply fails before any Hindsight/PostgreSQL write.

Supply a PostgreSQL database dedicated or approved for DLMF pilot schemas. The
runner creates a new unique `dlmf_pilot_*` schema and applies migrations 0001-0003
inside that schema. It does not use `public`.

The Hindsight TypeScript client is loaded from OmniHarness, keeping Hindsight out of
DLMF canonical package dependencies.

```bash
HERMES_HOME="$HOME/.hermes" \
DLMF_PILOT_HERMES_DB="$HOME/.hermes/state.db" \
DLMF_PILOT_PLAN_MANIFEST="$HOME/.local/state/dlmf/production-pilot/<reviewed-plan>-manifest.json" \
OMNIHARNESS_DIR='/path/to/OmniHarness' \
npm run pilot:memory-distillation -- --apply
```

Optional explicit Hindsight override:

```bash
DLMF_PILOT_HINDSIGHT_URL='http://localhost:8888'
```

Do not point either pilot bank at Nancy's existing Hindsight bank. Defaults are:

```text
nancy-dlmf-pilot-distillation-v011
nancy-dlmf-pilot-canonical-v011
```

## Apply flow per session

```text
Hermes transcript
 -> raw archive + checksum
 -> Hindsight distillation plane
 -> MemoryCandidate(s)
 -> pilot governance
 -> CanonicalMemory in isolated pilot namespace
 -> DistillationReceipt COMPLETE/FAILED
 -> canonical projection into isolated Hindsight projection bank
 -> PruneEligibilityDecision
```

After all five sessions, the runner also performs one real Hindsight reflective
synthesis using pilot canonical memories. The output must remain a pending derived
candidate and is never committed by the reflective service.

## Report

The detailed report is written with file mode `0600` under:

```text
~/.local/state/dlmf/production-pilot/
```

It contains, for each sample:

- reviewed Plan manifest/run ID and pinned transcript checksum;
- raw transcript checksum/archive reference;
- distillation receipt/outcome;
- candidate text/type/epistemic status;
- canonical text/ID/fingerprint;
- prune eligibility decision;
- explicit `deletionExecuted=false`.

Raw transcript content remains in the raw archive rather than being printed to the
terminal.

## Acceptance

The pilot is accepted only if all of the following are manually reviewed:

```ini
FIVE_REAL_SESSIONS_SELECTED=PASS
PLAN_MANIFEST_PINNED=PASS
TRANSCRIPT_CHECKSUMS_UNCHANGED=PASS
RAW_ARCHIVE_VERIFIED=PASS
HINDSIGHT_DISTILLATION_REAL=PASS
CANDIDATE_QUALITY_REVIEW=PASS
CANONICAL_GOVERNANCE_REVIEW=PASS
REFLECTIVE_EPISTEMIC_BOUNDARY=PASS
PRUNE_ELIGIBILITY_ONLY=PASS
HERMES_PRUNE_EXECUTED=false
PRODUCTION_PILOT=PASS
```

A successful pilot still does not authorize bulk migration of ~11,216 sessions or
automatic pruning. Bulk migration is a separate bounded and resumable operational
stage.

## Inspect a failed apply

A failed apply must not be rerun blindly. Inspect the existing private report first:

```bash
npm run pilot:memory-distillation:inspect -- /path/to/pilot-report.json
```

The inspector prints only receipt status, bounded/sanitized error diagnostics, error
fingerprints, reflection count, and Hermes delete count. It does not print raw
transcript content.

Machine success is fail-closed: any non-complete receipt, pending canonicalization
outcome, zero aggregate candidates/canonical memories, or zero reflective candidates
causes `PRODUCTION_PILOT=FAIL` and a non-zero exit code.

## Inspect a partially completed run

If Apply reaches canonicalization but fails later (for example during Reflection),
inspect the preserved PostgreSQL schema without re-running any provider work:

```bash
npm run pilot:memory-distillation:inspect-run -- pilot_YYYYMMDDhhmmss
```

This reports per-source receipt status, candidate/canonical counts, prune eligibility,
and aggregate candidate/head/revision/change counts. It never prints canonical text or
raw transcripts. Reflection errors are now captured into the private run report; they
do not erase the completed session evidence.

When any of the five session receipts is not `complete`, Reflection is skipped with
`reason=session_failures_present`. The pilot never reflects over a partial or
non-representative sample. The run inspector prints bounded/sanitized receipt error
messages and classifies common Hindsight failures (auth, context limit, payload size,
timeout, async requirement, reflect tool-call capability).
