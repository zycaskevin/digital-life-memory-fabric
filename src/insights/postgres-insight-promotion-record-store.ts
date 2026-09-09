import { Pool } from "pg";
import { ValidationError } from "../domain/errors.js";
import type {
  CandidateId,
  MemoryAuthor,
  MemoryId,
  MemoryScope,
  MemoryType,
} from "../domain/types.js";
import type { InsightPromotionRecordStore } from "./insight-promotion-record-store.js";
import type {
  InsightPromotionEligibility,
  InsightPromotionRecord,
  InsightPromotionRecordId,
  InsightPromotionStatus,
  ReflectiveInsightId,
} from "./types.js";

interface PromotionRow {
  promotion_id: string;
  insight_id: string;
  tenant_id: string;
  life_did: string;
  memory_namespace: string;
  idempotency_key: string;
  promotion_policy_version: string;
  approved_by: MemoryAuthor;
  eligibility: InsightPromotionEligibility;
  memory_type: MemoryType;
  semantic_key: string;
  status: InsightPromotionStatus;
  candidate_id: string | null;
  canonical_memory_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

function fromRow(row: PromotionRow): InsightPromotionRecord {
  return {
    promotionId: row.promotion_id as InsightPromotionRecordId,
    insightId: row.insight_id as ReflectiveInsightId,
    scope: {
      tenantId: row.tenant_id,
      lifeDid: row.life_did,
      memoryNamespace: row.memory_namespace,
    },
    idempotencyKey: row.idempotency_key,
    promotionPolicyVersion: row.promotion_policy_version,
    approvedBy: row.approved_by,
    eligibility: row.eligibility,
    memoryType: row.memory_type,
    semanticKey: row.semantic_key,
    status: row.status,
    ...(row.candidate_id === null ? {} : { candidateId: row.candidate_id as CandidateId }),
    ...(row.canonical_memory_id === null
      ? {}
      : { canonicalMemoryId: row.canonical_memory_id as MemoryId }),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export class PostgresInsightPromotionRecordStore implements InsightPromotionRecordStore {
  constructor(private readonly pool: Pool) {}

  async put(record: InsightPromotionRecord): Promise<void> {
    const result = await this.pool.query(
      `INSERT INTO insight_promotion_records (
         promotion_id, insight_id, tenant_id, life_did, memory_namespace,
         idempotency_key, promotion_policy_version, approved_by, eligibility,
         memory_type, semantic_key, status, candidate_id, canonical_memory_id,
         created_at, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15,$16
       )
       ON CONFLICT (promotion_id) DO UPDATE SET
         status=EXCLUDED.status,
         candidate_id=COALESCE(EXCLUDED.candidate_id, insight_promotion_records.candidate_id),
         canonical_memory_id=COALESCE(
           EXCLUDED.canonical_memory_id,
           insight_promotion_records.canonical_memory_id
         ),
         updated_at=EXCLUDED.updated_at
       WHERE insight_promotion_records.insight_id=EXCLUDED.insight_id
         AND insight_promotion_records.tenant_id=EXCLUDED.tenant_id
         AND insight_promotion_records.life_did=EXCLUDED.life_did
         AND insight_promotion_records.memory_namespace=EXCLUDED.memory_namespace
         AND insight_promotion_records.idempotency_key=EXCLUDED.idempotency_key
         AND insight_promotion_records.promotion_policy_version=EXCLUDED.promotion_policy_version
         AND insight_promotion_records.approved_by=EXCLUDED.approved_by
         AND insight_promotion_records.eligibility=EXCLUDED.eligibility
         AND insight_promotion_records.memory_type=EXCLUDED.memory_type
         AND insight_promotion_records.semantic_key=EXCLUDED.semantic_key
         AND insight_promotion_records.created_at=EXCLUDED.created_at
         AND (
           insight_promotion_records.status=EXCLUDED.status
           OR (
             insight_promotion_records.status='approved'
             AND EXCLUDED.status='committed'
           )
         )
         AND (
           insight_promotion_records.canonical_memory_id IS NULL
           OR EXCLUDED.canonical_memory_id=insight_promotion_records.canonical_memory_id
         )`,
      [
        record.promotionId,
        record.insightId,
        record.scope.tenantId,
        record.scope.lifeDid,
        record.scope.memoryNamespace,
        record.idempotencyKey,
        record.promotionPolicyVersion,
        JSON.stringify(record.approvedBy),
        JSON.stringify(record.eligibility),
        record.memoryType,
        record.semanticKey,
        record.status,
        record.candidateId ?? null,
        record.canonicalMemoryId ?? null,
        record.createdAt,
        record.updatedAt,
      ],
    );
    if (result.rowCount !== 1) {
      throw new ValidationError("insight promotion write violated immutable or monotonic state");
    }
  }

  async get(promotionId: InsightPromotionRecordId): Promise<InsightPromotionRecord | undefined> {
    const result = await this.pool.query<PromotionRow>(
      `SELECT * FROM insight_promotion_records WHERE promotion_id=$1`,
      [promotionId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : fromRow(row);
  }

  async getByIdempotencyKey(
    scope: MemoryScope,
    idempotencyKey: string,
  ): Promise<InsightPromotionRecord | undefined> {
    const result = await this.pool.query<PromotionRow>(
      `SELECT * FROM insight_promotion_records
        WHERE tenant_id=$1 AND life_did=$2 AND memory_namespace=$3 AND idempotency_key=$4`,
      [scope.tenantId, scope.lifeDid, scope.memoryNamespace, idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : fromRow(row);
  }
}
