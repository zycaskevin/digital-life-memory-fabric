import { Pool } from "pg";
import {
  DLMF_CANONICAL_AUTHORITY,
  bootstrapDigitalLifeStackSchema,
  validatedDlmfSchema,
} from "./digital-life-stack-schema-lib.mjs";

const databaseUrl = requiredEnv("DLMF_DLS_DATABASE_URL");
const schema = validatedDlmfSchema(process.env.DLMF_DLS_SCHEMA || "dlmf_digital_life_stack");
const allowUpgrade = process.env.DLMF_DLS_ALLOW_UPGRADE === "1";

const admin = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000 });
try {
  await admin.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
} finally {
  await admin.end();
}

const pool = new Pool({
  connectionString: databaseUrl,
  options: `-c search_path=${schema}`,
  max: 1,
  connectionTimeoutMillis: 5_000,
});
try {
  const client = await pool.connect();
  try {
    const result = await bootstrapDigitalLifeStackSchema(client, {
      rootDir: process.cwd(),
      allowUpgrade,
    });
    console.log(
      `DLMF_DLS_BOOTSTRAP=PASS schema=${schema} state=${result.after.state} applied=${result.applied.length} canonical_authority=${DLMF_CANONICAL_AUTHORITY}`,
    );
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}
