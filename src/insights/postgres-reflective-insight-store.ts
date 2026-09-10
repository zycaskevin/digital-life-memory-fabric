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
    if (insight.status !== "pending") {
      const result = await this.pool.query(
        `UPDATE reflective_insights SET
           status=$14,
           promotion_eligibility=$15::jsonb,
           updated_at=$18
         WHERE insight_id=$1
           AND tenant_id=$2
           AND life_did=$3
           AND memory_namespace=$4
           AND proposition=$5
           AND epistemic_status=$6
           AND supporting_memory_ids=$7::text[]
           AND supporting_evidence_ids=$8::text[]
           AND contradicting_memory_ids=$9::text[]
           AND confidence=$10
           AND derivation_provider=$11
           AND derivation_model=$12
           AND derivation_run_id=$13
           AND canonical_write_performed=$16
           AND created_at=$17`,
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
      if (result.rowCount !== 1) {
        throw new ValidationError("reflective insight write changed immutable fields");
      }
      return;
    }
    const result = await this.pool.query(
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
         updated_at=EXCLUDED.updated_at
       WHERE reflective_insights.tenant_id=EXCLUDED.tenant_id
         AND reflective_insights.life_did=EXCLUDED.life_did
         AND reflective_insights.memory_namespace=EXCLUDED.memory_namespace
         AND reflective_insights.proposition=EXCLUDED.proposition
         AND reflective_insights.epistemic_status=EXCLUDED.epistemic_status
         AND reflective_insights.supporting_memory_ids=EXCLUDED.supporting_memory_ids
         AND reflective_insights.supporting_evidence_ids=EXCLUDED.supporting_evidence_ids
         AND reflective_insights.contradicting_memory_ids=EXCLUDED.contradicting_memory_ids
         AND reflective_insights.confidence=EXCLUDED.confidence
         AND reflective_insights.derivation_provider=EXCLUDED.derivation_provider
         AND reflective_insights.derivation_model=EXCLUDED.derivation_model
         AND reflective_insights.derivation_run_id=EXCLUDED.derivation_run_id
         AND reflective_insights.canonical_write_performed=EXCLUDED.canonical_write_performed
         AND reflective_insights.created_at=EXCLUDED.created_at`,
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
    if (result.rowCount !== 1) {
      throw new ValidationError("reflective insight write changed immutable fields");
    }
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
