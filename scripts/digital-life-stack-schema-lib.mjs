import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const DLMF_CANONICAL_AUTHORITY = "digital-life-memory-fabric";
export const DLMF_DLS_SCHEMA_CONTRACT = "dlmf/digital-life-stack-schema/v1";
export const DLMF_DLS_EXPECTED_STATE = "current-0007";
export const DLMF_DLS_MIGRATIONS = [
  "0001_canonical_core.sql",
  "0002_central_operations.sql",
  "0003_memory_distillation.sql",
  "0004_canonical_admission.sql",
  "0005_semantic_governance.sql",
  "0006_semantic_review_queue.sql",
  "0007_insight_promotion_governance.sql",
];

const TRACKED_MIGRATIONS = new Set([
  "0006_semantic_review_queue.sql",
  "0007_insight_promotion_governance.sql",
]);

export function validatedDlmfSchema(value) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,62}$/u.test(value)) {
    throw new Error("DLMF_DLS_SCHEMA invalid");
  }
  return value;
}

export async function inspectDigitalLifeStackSchema(queryable) {
  const objects = (await queryable.query(`SELECT
    to_regclass('memory_candidates') AS memory_candidates,
    to_regclass('memory_heads') AS memory_heads,
    to_regclass('memory_changes') AS memory_changes,
    to_regclass('memory_outbox') AS memory_outbox,
    to_regclass('memory_distillation_receipts') AS receipts,
    to_regclass('memory_curation_records') AS curation,
    to_regclass('reflective_insights') AS insights,
    to_regclass('insight_promotion_records') AS promotions,
    to_regclass('semantic_review_cases') AS review_cases,
    to_regclass('semantic_review_events') AS review_events,
    to_regclass('insight_promotion_events') AS promotion_events,
    to_regclass('dlfm_schema_migrations') AS ledger`)).rows[0] ?? {};

  const present = Object.fromEntries(
    Object.entries(objects).map(([name, value]) => [name, value != null]),
  );
  const allAbsent = Object.values(present).every((value) => value === false);
  const through0005 = [
    "memory_candidates", "memory_heads", "memory_changes", "memory_outbox",
    "receipts", "curation", "insights", "promotions",
  ].every((name) => present[name] === true);
  const reviewComplete = present.review_cases === true && present.review_events === true;

  let ledger = [];
  if (present.ledger === true) {
    ledger = (await queryable.query(
      "SELECT migration_name FROM dlfm_schema_migrations ORDER BY migration_name",
    )).rows.map((row) => String(row.migration_name));
  }
  const ledgerSet = new Set(ledger);
  const ledgerKnown = ledger.every((name) => TRACKED_MIGRATIONS.has(name));
  const has0006 = ledgerSet.has("0006_semantic_review_queue.sql");
  const has0007 = ledgerSet.has("0007_insight_promotion_governance.sql");

  let state = "partial-or-future";
  if (allAbsent) {
    state = "empty";
  } else if (through0005 && !reviewComplete && !present.promotion_events && !present.ledger) {
    state = "stale-0005";
  } else if (
    through0005 && reviewComplete && !present.promotion_events && present.ledger
    && ledgerKnown && ledger.length === 1 && has0006 && !has0007
  ) {
    state = "stale-0006";
  } else if (
    through0005 && reviewComplete && present.promotion_events && present.ledger
    && ledgerKnown && ledger.length === 2 && has0006 && has0007
  ) {
    state = DLMF_DLS_EXPECTED_STATE;
  }

  const shapeChecks = state === DLMF_DLS_EXPECTED_STATE
    ? await verifyCurrentShape(queryable)
    : { ok: false, checks: {} };

  return {
    contract: DLMF_DLS_SCHEMA_CONTRACT,
    canonicalAuthority: DLMF_CANONICAL_AUTHORITY,
    state,
    ready: state === DLMF_DLS_EXPECTED_STATE && shapeChecks.ok,
    ledger,
    objects: present,
    shapeChecks: shapeChecks.checks,
  };
}

export async function bootstrapDigitalLifeStackSchema(
  client,
  { rootDir = process.cwd(), allowUpgrade = false } = {},
) {
  const schema = await currentSchema(client);
  const lockKey = `dlmf-digital-life-stack-schema:${schema}`;
  await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
  try {
    const before = await inspectDigitalLifeStackSchema(client);
    if (before.ready) return { before, after: before, applied: [] };
    if (before.state === "partial-or-future") {
      throw new Error(
        "DLMF schema is partial, corrupted, or newer than this integration contract; refusing automatic repair",
      );
    }
    if ((before.state === "stale-0005" || before.state === "stale-0006") && !allowUpgrade) {
      throw new Error(
        `DLMF schema ${before.state} is stale; explicit DLMF_DLS_ALLOW_UPGRADE=1 is required`,
      );
    }

    const migrations = before.state === "empty"
      ? DLMF_DLS_MIGRATIONS
      : before.state === "stale-0005"
        ? DLMF_DLS_MIGRATIONS.slice(5)
        : before.state === "stale-0006"
          ? DLMF_DLS_MIGRATIONS.slice(6)
          : [];
    const applied = [];
    for (const migration of migrations) {
      await client.query(await readFile(resolve(rootDir, "migrations", migration), "utf8"));
      applied.push(migration);
    }

    const after = await inspectDigitalLifeStackSchema(client);
    if (!after.ready) {
      throw new Error(
        `DLMF schema bootstrap did not reach ${DLMF_DLS_EXPECTED_STATE}; state=${after.state}`,
      );
    }
    return { before, after, applied };
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
  }
}

async function currentSchema(queryable) {
  const row = (await queryable.query("SELECT current_schema() AS schema")).rows[0];
  if (!row?.schema) throw new Error("DLMF schema search_path did not resolve a current schema");
  return String(row.schema);
}

async function verifyCurrentShape(queryable) {
  const columns = (await queryable.query(`SELECT
    EXISTS(SELECT 1 FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='memory_candidates' AND column_name='semantic_key')
      AS candidate_semantic_key,
    EXISTS(SELECT 1 FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='insight_promotion_records' AND column_name='approval_evidence_ids')
      AS promotion_approval_evidence,
    EXISTS(SELECT 1 FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='reflective_insights' AND column_name='canonical_write_performed')
      AS insight_write_guard`)).rows[0] ?? {};
  const triggers = (await queryable.query(`SELECT
    EXISTS(SELECT 1 FROM pg_trigger
      WHERE tgrelid='semantic_review_events'::regclass
        AND tgname='semantic_review_events_append_only' AND NOT tgisinternal)
      AS semantic_review_append_only,
    EXISTS(SELECT 1 FROM pg_trigger
      WHERE tgrelid='insight_promotion_events'::regclass
        AND tgname='insight_promotion_events_append_only' AND NOT tgisinternal)
      AS promotion_events_append_only`)).rows[0] ?? {};
  const checks = {
    candidateSemanticKey: columns.candidate_semantic_key === true,
    promotionApprovalEvidence: columns.promotion_approval_evidence === true,
    reflectiveInsightWriteGuard: columns.insight_write_guard === true,
    semanticReviewEventsAppendOnly: triggers.semantic_review_append_only === true,
    promotionEventsAppendOnly: triggers.promotion_events_append_only === true,
  };
  return { ok: Object.values(checks).every(Boolean), checks };
}
