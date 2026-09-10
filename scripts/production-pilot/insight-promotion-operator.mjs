import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Pool } from "pg";
import {
  InsightPromotionOperator,
  PostgresCanonicalMemoryStore,
  PostgresInsightPromotionRecordStore,
  PostgresInsightPromotionStateReader,
  PostgresReflectiveInsightStore,
} from "../../dist/index.js";

const argv = process.argv.slice(2);
const mode = argv[0];
if (!["plan", "dry-run", "apply"].includes(mode)) {
  console.error("Usage: insight-promotion-operator.mjs <plan|dry-run|apply> [options]");
  process.exit(2);
}

function argument(name) {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}
function requiredArgument(name) {
  const value = argument(name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length);
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (value.length >= 2 && value[0] === value.at(-1) && ["'", '"'].includes(value[0])) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}
function privateOutput(path, reportRoot) {
  const resolved = resolve(path);
  const root = resolve(reportRoot);
  if (relative(root, resolved).startsWith(`..${sep}`) || relative(root, resolved) === "..") {
    throw new Error(`Output must stay inside protected report root ${root}.`);
  }
  return resolved;
}
async function writePrivateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}
async function readJson(path) {
  const resolved = resolve(path);
  if (!isAbsolute(resolved)) throw new Error("Input path must resolve absolutely.");
  return JSON.parse(await readFile(resolved, "utf8"));
}

const home = process.env.HOME || homedir();
const envFile = resolve(
  process.env.DLMF_PILOT_ENV_FILE || join(home, ".config", "dlmf", "production-pilot.env"),
);
const config = parseEnvFile(envFile);
const databaseUrl = process.env.DLMF_PILOT_DATABASE_URL || config.DLMF_PILOT_DATABASE_URL;
if (!databaseUrl) throw new Error("DLMF pilot PostgreSQL is not configured.");
const schema = argument("--schema") || process.env.DLMF_PILOT_SCHEMA;
if (!schema || !/^dlmf_(?:pilot|promotion_canary)_[a-z0-9_]+$/.test(schema)) {
  throw new Error("--schema must name an isolated dlmf_pilot_* or dlmf_promotion_canary_* schema.");
}
const reportRoot = resolve(
  process.env.DLMF_PILOT_REPORT_ROOT || join(home, ".local", "state", "dlmf", "production-pilot"),
);
const outputPath = privateOutput(requiredArgument("--output"), reportRoot);
if (mode === "apply" && process.env.DLMF_PROMOTION_APPLY_SCHEMA !== schema) {
  throw new Error("Apply is fail-closed unless DLMF_PROMOTION_APPLY_SCHEMA exactly matches --schema.");
}

const readOnly = mode !== "apply";
const pool = new Pool({
  connectionString: databaseUrl,
  max: 6,
  options: `-c search_path=${schema}${readOnly ? " -c default_transaction_read_only=on" : ""}`,
});
const canonicalStore = new PostgresCanonicalMemoryStore(pool);
try {
  const readiness = await pool.query(`SELECT
    to_regclass('reflective_insights') IS NOT NULL AS insights,
    to_regclass('insight_promotion_records') IS NOT NULL AS promotions,
    to_regclass('insight_promotion_events') IS NOT NULL AS events,
    EXISTS(SELECT 1 FROM dlfm_schema_migrations WHERE migration_name='0007_insight_promotion_governance.sql') AS migration`);
  if (!Object.values(readiness.rows[0] ?? {}).every((value) => value === true)) {
    throw new Error(`Schema ${schema} is not ready for governed promotion migration 0007.`);
  }
  const insightStore = new PostgresReflectiveInsightStore(pool);
  const promotionStore = new PostgresInsightPromotionRecordStore(pool);
  const operator = new InsightPromotionOperator({
    canonicalStore,
    insightStore,
    promotionStore,
    stateReader: new PostgresInsightPromotionStateReader(pool),
  });
  if (mode === "plan") {
    const scope = {
      tenantId: requiredArgument("--tenant-id"),
      lifeDid: requiredArgument("--life-did"),
      memoryNamespace: requiredArgument("--namespace"),
    };
    const insightId = requiredArgument("--insight-id");
    const expiresSeconds = Number(argument("--expires-seconds") || "900");
    const plan = await operator.createPlan({
      scope,
      insightId,
      expiresInMs: expiresSeconds * 1_000,
    });
    await writePrivateJson(outputPath, plan);
    console.log(JSON.stringify({ mode, schema, outputPath, planId: plan.planId, planChecksum: plan.planChecksum }));
  } else {
    const plan = await readJson(requiredArgument("--plan"));
    const approval = await readJson(requiredArgument("--approval"));
    const report = mode === "dry-run"
      ? await operator.dryRun(plan, approval)
      : await operator.apply(plan, approval);
    await writePrivateJson(outputPath, { schema, ...report, rawContentIncluded: false });
    console.log(JSON.stringify({
      mode,
      schema,
      outputPath,
      planId: report.planId,
      canonicalWritePerformed: mode === "apply" && report.promotionCanonicalCommitPerformed === true,
      automaticPromotionEnabled: false,
      automaticPruningEnabled: false,
    }));
  }
} finally {
  await canonicalStore.close();
}
