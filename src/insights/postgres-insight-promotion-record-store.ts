import { Pool } from "pg";
import { ValidationError } from "../domain/errors.js";
import { scopeKey } from "../domain/utils.js";
import type {
  CandidateId,
  MemoryAuthor,
  MemoryId,
  MemoryScope,
  MemoryType,
} from "../domain/types.js";
import type { InsightPromotionRecordStore } from "./insight-promotion-record-store.js";
import type {
  InsightPromotionEvent,
  InsightPromotionEventId,
  InsightPromotionEventType,
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
  approval_evidence_ids: string[];
  eligibility: InsightPromotionEligibility;
  memory_type: MemoryType;
  semantic_key: string;
  status: InsightPromotionStatus;
  candidate_id: string | null;
  canonical_memory_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}
interface PromotionEventRow {
  event_id: string;
  promotion_id: string;
  insight_id: string;
  tenant_id: string;
  life_did: string;
  memory_namespace: string;
  event_type: InsightPromotionEventType;
  status: InsightPromotionStatus;
  approved_by: MemoryAuthor;
  approval_evidence_ids: string[];
  eligibility: InsightPromotionEligibility;
  candidate_id: string | null;
  canonical_memory_id: string | null;
  occurred_at: Date | string;
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
    approvalEvidenceIds: row.approval_evidence_ids,
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

function eventFromRow(row: PromotionEventRow): InsightPromotionEvent {
  return {
    eventId: row.event_id as InsightPromotionEventId,
    promotionId: row.promotion_id as InsightPromotionRecordId,
    insightId: row.insight_id as ReflectiveInsightId,
    scope: {
      tenantId: row.tenant_id,
      lifeDid: row.life_did,
      memoryNamespace: row.memory_namespace,
    },
    eventType: row.event_type,
    status: row.status,
    approvedBy: row.approved_by,
    approvalEvidenceIds: row.approval_evidence_ids,
    eligibility: row.eligibility,
    ...(row.candidate_id === null ? {} : { candidateId: row.candidate_id as CandidateId }),
    ...(row.canonical_memory_id === null
      ? {}
      : { canonicalMemoryId: row.canonical_memory_id as MemoryId }),
    occurredAt: iso(row.occurred_at),
  };
}
export class PostgresInsightPromotionRecordStore implements InsightPromotionRecordStore {
  constructor(private readonly pool: Pool) {}

  async put(record: InsightPromotionRecord): Promise<void> {
    if (!Array.isArray(record.approvalEvidenceIds) || record.approvalEvidenceIds.length === 0) {
      throw new ValidationError("insight promotion approval evidence is required");
    }
    const result = await this.pool.query(
      `INSERT INTO insight_promotion_records (
         promotion_id, insight_id, tenant_id, life_did, memory_namespace,
         idempotency_key, promotion_policy_version, approved_by, approval_evidence_ids,
         eligibility, memory_type, semantic_key, status, candidate_id, canonical_memory_id,
         created_at, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::text[],$10::jsonb,$11,$12,$13,$14,$15,$16,$17
       )
       ON CONFLICT (promotion_id) DO UPDATE SET
         status=EXCLUDED.status,
         candidate_id=COALESCE(insight_promotion_records.candidate_id, EXCLUDED.candidate_id),
         canonical_memory_id=COALESCE(
           insight_promotion_records.canonical_memory_id,
           EXCLUDED.canonical_memory_id
         ),
         updated_at=EXCLUDED.updated_at
       WHERE insight_promotion_records.insight_id=EXCLUDED.insight_id
         AND insight_promotion_records.tenant_id=EXCLUDED.tenant_id
         AND insight_promotion_records.life_did=EXCLUDED.life_did
         AND insight_promotion_records.memory_namespace=EXCLUDED.memory_namespace
         AND insight_promotion_records.idempotency_key=EXCLUDED.idempotency_key
         AND insight_promotion_records.promotion_policy_version=EXCLUDED.promotion_policy_version
         AND insight_promotion_records.approved_by=EXCLUDED.approved_by
         AND insight_promotion_records.approval_evidence_ids=EXCLUDED.approval_evidence_ids
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
           insight_promotion_records.candidate_id IS NULL
           OR EXCLUDED.candidate_id=insight_promotion_records.candidate_id
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
        record.approvalEvidenceIds,
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
  async getByInsightId(
    scope: MemoryScope,
    insightId: ReflectiveInsightId,
  ): Promise<InsightPromotionRecord | undefined> {
    const result = await this.pool.query<PromotionRow>(
      "SELECT * FROM insight_promotion_records WHERE insight_id=$1 AND tenant_id=$2 AND life_did=$3 AND memory_namespace=$4",
      [insightId, scope.tenantId, scope.lifeDid, scope.memoryNamespace],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : fromRow(row);
  }

  async listEvents(
    scope: MemoryScope,
    promotionId: InsightPromotionRecordId,
  ): Promise<InsightPromotionEvent[]> {
    const result = await this.pool.query<PromotionEventRow>(
      "SELECT * FROM insight_promotion_events WHERE promotion_id=$1 AND tenant_id=$2 AND life_did=$3 AND memory_namespace=$4 ORDER BY CASE event_type WHEN 'approved' THEN 1 WHEN 'candidate_linked' THEN 2 WHEN 'committed' THEN 3 WHEN 'rejected' THEN 1 ELSE 9 END, occurred_at, event_id",
      [promotionId, scope.tenantId, scope.lifeDid, scope.memoryNamespace],
    );
    return result.rows.map(eventFromRow);
  }

  async withInsightLock<T>(
    scope: MemoryScope,
    insightId: ReflectiveInsightId,
    work: () => Promise<T>,
  ): Promise<T> {
    if (this.pool.options.max < 2) {
      throw new ValidationError(
        "PostgreSQL insight promotion requires a pool with at least two connections",
      );
    }
    const client = await this.pool.connect();
    const lockKey = "insight-promotion:" + scopeKey(scope) + "\u001f" + insightId;
    let transactionStarted = false;
    let workFailed = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
      return await work();
    } catch (error) {
      workFailed = true;
      throw error;
    } finally {
      let cleanupError: unknown;
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (error) {
          cleanupError = error;
        }
      }
      client.release(cleanupError !== undefined);
      if (!workFailed && cleanupError !== undefined) throw cleanupError;
    }
  }

}
