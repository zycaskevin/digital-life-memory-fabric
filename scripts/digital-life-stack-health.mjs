import { Pool } from "pg";
import {
  DLMF_CANONICAL_AUTHORITY,
  DLMF_DLS_SCHEMA_CONTRACT,
  inspectDigitalLifeStackSchema,
  validatedDlmfSchema,
} from "./digital-life-stack-schema-lib.mjs";

const databaseUrl = requiredEnv("DLMF_DLS_DATABASE_URL");
const schema = validatedDlmfSchema(process.env.DLMF_DLS_SCHEMA || "dlmf_digital_life_stack");
const pool = new Pool({
  connectionString: databaseUrl,
  options: `-c search_path=${schema} -c default_transaction_read_only=on`,
  max: 1,
  connectionTimeoutMillis: 5_000,
});
try {
  const state = await inspectDigitalLifeStackSchema(pool);
  if (!state.ready) {
    console.error(`DLMF_DLS_READINESS=FAIL schema=${schema} state=${state.state}`);
    process.exitCode = 1;
  } else {
    console.log(
      `DLMF_DLS_READINESS=PASS schema=${schema} state=${state.state} contract=${DLMF_DLS_SCHEMA_CONTRACT} canonical_authority=${DLMF_CANONICAL_AUTHORITY}`,
    );
  }
} catch (error) {
  console.error(`DLMF_DLS_READINESS=FAIL reason=${publicReason(error)}`);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => undefined);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function publicReason(error) {
  const message = error instanceof Error ? error.message : "unknown_error";
  return message.replace(/postgres(?:ql)?:\/\/[^\s]+/giu, "postgres://[redacted]").slice(0, 240);
}
