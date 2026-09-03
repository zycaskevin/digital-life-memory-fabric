import { Pool } from "pg";
import type { MemoryScope } from "../domain/types.js";
import type { DistillationReceiptStore } from "./distillation-receipt-store.js";
import type {
  CanonicalizationOutcome,
  DistillationErrorRecord,
  DistillationReceipt,
  DistillationReceiptId,
  DistillationReceiptStatus,
  RetentionState,
} from "./types.js";

interface ReceiptRow {
  receipt_id: string;
  tenant_id: string;
  life_did: string;
  memory_namespace: string;
  source_type: string;
  source_id: string;
  idempotency_key: string;
  ingested_at: Date | string | null;
  archived_at: Date | string | null;
  distilled_at: Date | string | null;
  canonicalized_at: Date | string | null;
  raw_archive_ref: string | null;
  raw_archive_checksum: string | null;
  provider: string;
  provider_run_id: string | null;
  distillation_policy_version: string;
  canonicalization_policy_version: string;
  retention_policy_version: string;
  adapter_version: string;
  provider_version: string | null;
  candidate_ids: string[];
  canonical_memory_ids: string[];
  status: DistillationReceiptStatus;
  errors: DistillationErrorRecord[];
  warnings: string[];
  canonicalization_outcome: CanonicalizationOutcome;
  retention_state: RetentionState;
  prune_eligible: boolean;
  attempts: number;
  created_at: Date | string;
  updated_at: Date | string;
}

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const optionalIso = (value: Date | string | null): string | undefined =>
  value === null ? undefined : iso(value);

function fromRow(row: ReceiptRow): DistillationReceipt {
  const receipt: DistillationReceipt = {
    receiptId: row.receipt_id as DistillationReceiptId,
    scope: {
      tenantId: row.tenant_id,
      lifeDid: row.life_did,
      memoryNamespace: row.memory_namespace,
    },
    sourceType: row.source_type,
    sourceId: row.source_id,
    idempotencyKey: row.idempotency_key,
    provider: row.provider,
    distillationPolicyVersion: row.distillation_policy_version,
    canonicalizationPolicyVersion: row.canonicalization_policy_version,
    retentionPolicyVersion: row.retention_policy_version,
    adapterVersion: row.adapter_version,
    candidateIds: row.candidate_ids as DistillationReceipt["candidateIds"],
    canonicalMemoryIds: row.canonical_memory_ids as DistillationReceipt["canonicalMemoryIds"],
    status: row.status,
    errors: row.errors,
    warnings: row.warnings,
    canonicalizationOutcome: row.canonicalization_outcome,
    retentionState: row.retention_state,
    pruneEligible: row.prune_eligible,
    attempts: row.attempts,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
  const ingestedAt = optionalIso(row.ingested_at);
  const archivedAt = optionalIso(row.archived_at);
  const distilledAt = optionalIso(row.distilled_at);
  const canonicalizedAt = optionalIso(row.canonicalized_at);
  if (ingestedAt !== undefined) receipt.ingestedAt = ingestedAt;
  if (archivedAt !== undefined) receipt.archivedAt = archivedAt;
  if (distilledAt !== undefined) receipt.distilledAt = distilledAt;
  if (canonicalizedAt !== undefined) receipt.canonicalizedAt = canonicalizedAt;
  if (row.raw_archive_ref !== null) receipt.rawArchiveRef = row.raw_archive_ref;
  if (row.raw_archive_checksum !== null) receipt.rawArchiveChecksum = row.raw_archive_checksum;
  if (row.provider_run_id !== null) receipt.providerRunId = row.provider_run_id;
  if (row.provider_version !== null) receipt.providerVersion = row.provider_version;
  return receipt;
}

export class PostgresDistillationReceiptStore implements DistillationReceiptStore {
  constructor(private readonly pool: Pool) {}

  async getByIdempotencyKey(
    scope: MemoryScope,
    idempotencyKey: string,
  ): Promise<DistillationReceipt | undefined> {
    const result = await this.pool.query<ReceiptRow>(
      `SELECT * FROM memory_distillation_receipts
        WHERE tenant_id=$1 AND life_did=$2 AND memory_namespace=$3 AND idempotency_key=$4`,
      [scope.tenantId, scope.lifeDid, scope.memoryNamespace, idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : fromRow(row);
  }

  async getLatestBySource(
    scope: MemoryScope,
    sourceType: string,
    sourceId: string,
  ): Promise<DistillationReceipt | undefined> {
    const result = await this.pool.query<ReceiptRow>(
      `SELECT * FROM memory_distillation_receipts
        WHERE tenant_id=$1 AND life_did=$2 AND memory_namespace=$3
          AND source_type=$4 AND source_id=$5
        ORDER BY updated_at DESC, receipt_id DESC
        LIMIT 1`,
      [scope.tenantId, scope.lifeDid, scope.memoryNamespace, sourceType, sourceId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : fromRow(row);
  }

  async put(receipt: DistillationReceipt): Promise<void> {
    await this.pool.query(
      `INSERT INTO memory_distillation_receipts (
        receipt_id, tenant_id, life_did, memory_namespace,
        source_type, source_id, idempotency_key,
        ingested_at, archived_at, distilled_at, canonicalized_at,
        raw_archive_ref, raw_archive_checksum,
        provider, provider_run_id,
        distillation_policy_version, canonicalization_policy_version,
        retention_policy_version, adapter_version, provider_version,
        candidate_ids, canonical_memory_ids, status, errors, warnings,
        canonicalization_outcome, retention_state, prune_eligible, attempts,
        created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21::text[],$22::text[],$23,$24::jsonb,$25::jsonb,$26,$27,$28,$29,$30,$31
      )
      ON CONFLICT (tenant_id, life_did, memory_namespace, idempotency_key)
      DO UPDATE SET
        ingested_at=EXCLUDED.ingested_at,
        archived_at=EXCLUDED.archived_at,
        distilled_at=EXCLUDED.distilled_at,
        canonicalized_at=EXCLUDED.canonicalized_at,
        raw_archive_ref=EXCLUDED.raw_archive_ref,
        raw_archive_checksum=EXCLUDED.raw_archive_checksum,
        provider=EXCLUDED.provider,
        provider_run_id=EXCLUDED.provider_run_id,
        distillation_policy_version=EXCLUDED.distillation_policy_version,
        canonicalization_policy_version=EXCLUDED.canonicalization_policy_version,
        retention_policy_version=EXCLUDED.retention_policy_version,
        adapter_version=EXCLUDED.adapter_version,
        provider_version=EXCLUDED.provider_version,
        candidate_ids=ARRAY(
          SELECT DISTINCT value FROM unnest(
            memory_distillation_receipts.candidate_ids || EXCLUDED.candidate_ids
          ) AS value
        ),
        canonical_memory_ids=ARRAY(
          SELECT DISTINCT value FROM unnest(
            memory_distillation_receipts.canonical_memory_ids || EXCLUDED.canonical_memory_ids
          ) AS value
        ),
        status=CASE
          WHEN memory_distillation_receipts.status = 'complete' THEN 'complete'
          ELSE EXCLUDED.status
        END,
        errors=EXCLUDED.errors,
        warnings=EXCLUDED.warnings,
        canonicalization_outcome=CASE
          WHEN memory_distillation_receipts.canonicalization_outcome = 'committed'
            OR EXCLUDED.canonicalization_outcome = 'committed'
          THEN 'committed'
          ELSE EXCLUDED.canonicalization_outcome
        END,
        retention_state=CASE
          WHEN memory_distillation_receipts.retention_state = 'prune_eligible'
          THEN 'prune_eligible'
          ELSE EXCLUDED.retention_state
        END,
        prune_eligible=(memory_distillation_receipts.prune_eligible OR EXCLUDED.prune_eligible),
        attempts=EXCLUDED.attempts,
        updated_at=EXCLUDED.updated_at`,
      [
        receipt.receiptId,
        receipt.scope.tenantId,
        receipt.scope.lifeDid,
        receipt.scope.memoryNamespace,
        receipt.sourceType,
        receipt.sourceId,
        receipt.idempotencyKey,
        receipt.ingestedAt ?? null,
        receipt.archivedAt ?? null,
        receipt.distilledAt ?? null,
        receipt.canonicalizedAt ?? null,
        receipt.rawArchiveRef ?? null,
        receipt.rawArchiveChecksum ?? null,
        receipt.provider,
        receipt.providerRunId ?? null,
        receipt.distillationPolicyVersion,
        receipt.canonicalizationPolicyVersion,
        receipt.retentionPolicyVersion,
        receipt.adapterVersion,
        receipt.providerVersion ?? null,
        receipt.candidateIds,
        receipt.canonicalMemoryIds,
        receipt.status,
        JSON.stringify(receipt.errors),
        JSON.stringify(receipt.warnings),
        receipt.canonicalizationOutcome,
        receipt.retentionState,
        receipt.pruneEligible,
        receipt.attempts,
        receipt.createdAt,
        receipt.updatedAt,
      ],
    );
  }
}
