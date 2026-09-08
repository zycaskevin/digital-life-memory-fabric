import { Pool } from "pg";
import { ValidationError } from "../domain/errors.js";
import type { MemoryId } from "../domain/types.js";
import type { ReflectiveInsightStore } from "./reflective-insight-store.js";
import type {
  InsightPromotionEligibility,
  ReflectiveInsight,
  ReflectiveInsightId,
  ReflectiveInsightStatus,
} from "./types.js";

interface ReflectiveInsightRow {
  insight_id: string;
  tenant_id: string;
  life_did: string;
  memory_namespace: string;
  proposition: string;
  epistemic_status: ReflectiveInsight["epistemicStatus"];
  supporting_memory_ids: string[];
  supporting_evidence_ids: string[];
  contradicting_memory_ids: string[];
  confidence: string | number;
  derivation_provider: string;
  derivation_model: string;
  derivation_run_id: string;
  status: ReflectiveInsightStatus;
  promotion_eligibility: InsightPromotionEligibility;
  canonical_write_performed: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

function fromRow(row: ReflectiveInsightRow): ReflectiveInsight {
  if (row.canonical_write_performed) {
    throw new Error(`Reflective insight ${row.insight_id} violated the canonical write boundary`);
  }
  return {
    insightId: row.insight_id as ReflectiveInsightId,
    scope: {
      tenantId: row.tenant_id,
      lifeDid: row.life_did,
      memoryNamespace: row.memory_namespace,
    },
    proposition: row.proposition,
    epistemicStatus: row.epistemic_status,
    supportingMemoryIds: row.supporting_memory_ids as MemoryId[],
    supportingEvidenceIds: row.supporting_evidence_ids,
    contradictingMemoryIds: row.contradicting_memory_ids as MemoryId[],
    confidence: Number(row.confidence),
    derivationProvider: row.derivation_provider,
    derivationModel: row.derivation_model,
    derivationRunId: row.derivation_run_id,
    status: row.status,
    promotionEligibility: row.promotion_eligibility,
    canonicalWritePerformed: false,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export class PostgresReflectiveInsightStore implements ReflectiveInsightStore {
  constructor(private readonly pool: Pool) {}

  async put(insight: ReflectiveInsight): Promise<void> {
    if (insight.canonicalWritePerformed !== false) {
      throw new ValidationError("reflective insights cannot perform canonical writes");
    }
    await this.pool.query(
      `INSERT INTO reflective_insights (
         insight_id, tenant_id, life_did, memory_namespace, proposition,
         epistemic_status, supporting_memory_ids, supporting_evidence_ids,
         contradicting_memory_ids, confidence, derivation_provider,
         derivation_model, derivation_run_id, status, promotion_eligibility,
         canonical_write_performed, created_at, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7::text[],$8::text[],$9::text[],$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18
       )
       ON CONFLICT (insight_id) DO UPDATE SET
         status=EXCLUDED.status,
         promotion_eligibility=EXCLUDED.promotion_eligibility,
         updated_at=EXCLUDED.updated_at`,
      [
        insight.insightId,
        insight.scope.tenantId,
        insight.scope.lifeDid,
        insight.scope.memoryNamespace,
        insight.proposition,
        insight.epistemicStatus,
        insight.supportingMemoryIds,
        insight.supportingEvidenceIds,
        insight.contradictingMemoryIds,
        insight.confidence,
        insight.derivationProvider,
        insight.derivationModel,
        insight.derivationRunId,
        insight.status,
        JSON.stringify(insight.promotionEligibility),
        insight.canonicalWritePerformed,
        insight.createdAt,
        insight.updatedAt,
      ],
    );
  }

  async get(insightId: ReflectiveInsightId): Promise<ReflectiveInsight | undefined> {
    const result = await this.pool.query<ReflectiveInsightRow>(
      `SELECT * FROM reflective_insights WHERE insight_id=$1`,
      [insightId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : fromRow(row);
  }
}
