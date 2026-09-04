import { Pool } from "pg";
import type { EpistemicStatus, MemoryCandidate, MemoryScope } from "../domain/types.js";
import {
  curationRecordBacksCanonicalAdmission,
  type MemoryCurationRecordStore,
} from "./memory-curation-record-store.js";
import type {
  CurationRecordId,
  MemoryCurationRecord,
  MemoryDurability,
  ProviderMemoryUnitOutcome,
  SemanticDisposition,
} from "./types.js";

interface CurationRow {
  record_id: string;
  receipt_id: string;
  tenant_id: string;
  life_did: string;
  memory_namespace: string;
  source_type: string;
  source_id: string;
  provider_name: string;
  provider_run_id: string;
  provider_unit_ref: string;
  provider_unit_text: string;
  provider_unit_fingerprint: string;
  provider_epistemic_status: EpistemicStatus;
  curation_provider: string;
  curation_provider_version: string | null;
  admission_policy_version: string;
  outcome: ProviderMemoryUnitOutcome;
  attributed_epistemic_status: EpistemicStatus;
  durability: MemoryDurability;
  memory_worthy: boolean;
  semantic_disposition: SemanticDisposition;
  reason_codes: string[];
  target_memory_id: string | null;
  candidate_id: string | null;
  canonical_memory_id: string | null;
  created_at: Date | string;
}

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

function scopeFromRow(row: CurationRow): MemoryScope {
  return {
    tenantId: row.tenant_id,
    lifeDid: row.life_did,
    memoryNamespace: row.memory_namespace,
  };
}

function fromRow(row: CurationRow): MemoryCurationRecord {
  return {
    recordId: row.record_id as CurationRecordId,
    receiptId: row.receipt_id,
    scope: scopeFromRow(row),
    sourceType: row.source_type,
    sourceId: row.source_id,
    providerName: row.provider_name,
    providerRunId: row.provider_run_id,
    providerUnitRef: row.provider_unit_ref,
    providerUnitText: row.provider_unit_text,
    providerUnitFingerprint: row.provider_unit_fingerprint,
    providerEpistemicStatus: row.provider_epistemic_status,
    curationProvider: row.curation_provider,
    ...(row.curation_provider_version === null
      ? {}
      : { curationProviderVersion: row.curation_provider_version }),
    admissionPolicyVersion: row.admission_policy_version,
    outcome: row.outcome,
    attributedEpistemicStatus: row.attributed_epistemic_status,
    durability: row.durability,
    memoryWorthy: row.memory_worthy,
    semanticDisposition: row.semantic_disposition,
    reasonCodes: row.reason_codes,
    ...(row.target_memory_id === null
      ? {}
      : { targetMemoryId: row.target_memory_id as NonNullable<MemoryCurationRecord["targetMemoryId"]> }),
    ...(row.candidate_id === null
      ? {}
      : { candidateId: row.candidate_id as NonNullable<MemoryCurationRecord["candidateId"]> }),
    ...(row.canonical_memory_id === null
      ? {}
      : { canonicalMemoryId: row.canonical_memory_id as NonNullable<MemoryCurationRecord["canonicalMemoryId"]> }),
    createdAt: iso(row.created_at),
  };
}

export class PostgresMemoryCurationRecordStore implements MemoryCurationRecordStore {
  constructor(private readonly pool: Pool) {}

  async put(record: MemoryCurationRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO memory_curation_records (
         record_id, receipt_id, tenant_id, life_did, memory_namespace,
         source_type, source_id, provider_name, provider_run_id,
         provider_unit_ref, provider_unit_text, provider_unit_fingerprint,
         provider_epistemic_status, curation_provider, curation_provider_version,
         admission_policy_version, outcome, attributed_epistemic_status,
         durability, memory_worthy, semantic_disposition, reason_codes,
         target_memory_id, candidate_id, canonical_memory_id, created_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::text[],$23,$24,$25,$26
       )
       ON CONFLICT (record_id) DO UPDATE SET
         outcome=CASE
           WHEN memory_curation_records.canonical_memory_id IS NOT NULL
             AND EXCLUDED.canonical_memory_id IS NULL
           THEN memory_curation_records.outcome
           ELSE EXCLUDED.outcome
         END,
         attributed_epistemic_status=CASE
           WHEN memory_curation_records.canonical_memory_id IS NOT NULL
             AND EXCLUDED.canonical_memory_id IS NULL
           THEN memory_curation_records.attributed_epistemic_status
           ELSE EXCLUDED.attributed_epistemic_status
         END,
         durability=CASE
           WHEN memory_curation_records.canonical_memory_id IS NOT NULL
             AND EXCLUDED.canonical_memory_id IS NULL
           THEN memory_curation_records.durability
           ELSE EXCLUDED.durability
         END,
         memory_worthy=CASE
           WHEN memory_curation_records.canonical_memory_id IS NOT NULL
             AND EXCLUDED.canonical_memory_id IS NULL
           THEN memory_curation_records.memory_worthy
           ELSE EXCLUDED.memory_worthy
         END,
         semantic_disposition=CASE
           WHEN memory_curation_records.canonical_memory_id IS NOT NULL
             AND EXCLUDED.canonical_memory_id IS NULL
           THEN memory_curation_records.semantic_disposition
           ELSE EXCLUDED.semantic_disposition
         END,
         reason_codes=CASE
           WHEN memory_curation_records.canonical_memory_id IS NOT NULL
             AND EXCLUDED.canonical_memory_id IS NULL
           THEN memory_curation_records.reason_codes
           ELSE EXCLUDED.reason_codes
         END,
         target_memory_id=COALESCE(EXCLUDED.target_memory_id, memory_curation_records.target_memory_id),
         candidate_id=COALESCE(EXCLUDED.candidate_id, memory_curation_records.candidate_id),
         canonical_memory_id=COALESCE(EXCLUDED.canonical_memory_id, memory_curation_records.canonical_memory_id),
         created_at=CASE
           WHEN memory_curation_records.canonical_memory_id IS NOT NULL
             AND EXCLUDED.canonical_memory_id IS NULL
           THEN memory_curation_records.created_at
           ELSE EXCLUDED.created_at
         END`,
      [
        record.recordId,
        record.receiptId,
        record.scope.tenantId,
        record.scope.lifeDid,
        record.scope.memoryNamespace,
        record.sourceType,
        record.sourceId,
        record.providerName,
        record.providerRunId,
        record.providerUnitRef,
        record.providerUnitText,
        record.providerUnitFingerprint,
        record.providerEpistemicStatus,
        record.curationProvider,
        record.curationProviderVersion ?? null,
        record.admissionPolicyVersion,
        record.outcome,
        record.attributedEpistemicStatus,
        record.durability,
        record.memoryWorthy,
        record.semanticDisposition,
        record.reasonCodes,
        record.targetMemoryId ?? null,
        record.candidateId ?? null,
        record.canonicalMemoryId ?? null,
        record.createdAt,
      ],
    );
  }

  async listByReceipt(receiptId: string): Promise<MemoryCurationRecord[]> {
    const result = await this.pool.query<CurationRow>(
      `SELECT * FROM memory_curation_records
        WHERE receipt_id=$1
        ORDER BY provider_unit_ref ASC`,
      [receiptId],
    );
    return result.rows.map(fromRow);
  }

  async verifyCanonicalAdmission(candidate: MemoryCandidate): Promise<boolean> {
    const proof = candidate.canonicalAdmission;
    if (proof === undefined) return false;
    const result = await this.pool.query<CurationRow>(
      `SELECT * FROM memory_curation_records WHERE record_id=$1`,
      [proof.curationRecordId],
    );
    const row = result.rows[0];
    return curationRecordBacksCanonicalAdmission(
      row === undefined ? undefined : fromRow(row),
      candidate,
    );
  }
}
