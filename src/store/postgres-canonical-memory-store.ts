import { Pool, type PoolClient } from "pg";
import { ValidationError } from "../domain/errors.js";
import type {
  CanonicalCommitResult,
  CanonicalContent,
  CanonicalMemoryHead,
  CandidateId,
  CandidateStatus,
  DeviceCheckpoint,
  EvidenceRef,
  MemoryAuthor,
  MemoryCandidate,
  MemoryChangeEnvelope,
  MemoryClass,
  MemoryConflict,
  MemoryId,
  MemoryOperation,
  MemoryOutboxRecord,
  MemoryProvenance,
  MemoryRevision,
  MemoryRevisionRef,
  MemoryScope,
  MemoryStatus,
  ProviderMaterialization,
} from "../domain/types.js";
import { scopeKey } from "../domain/utils.js";
import type {
  CentralOperationsStore,
  CurrentHeadCursorRecord,
  SettleClaimRequest,
  SettledClaim,
} from "../operations/central-operations-store.js";
import type {
  ClaimedOutboxRecord,
  NamespaceOperationsSummary,
  ProviderMaterializationCursor,
} from "../operations/types.js";
import type {
  CanonicalMemoryStoreTx,
} from "./canonical-memory-store.js";

interface CandidateRow {
  candidate_id: string;
  tenant_id: string;
  life_did: string;
  memory_namespace: string;
  origin: MemoryAuthor;
  candidate_type: string;
  source_type: string;
  source_id: string | null;
  memory_class: MemoryClass;
  memory_kind: string;
  proposed_text: string;
  proposed_payload: Record<string, unknown> | null;
  evidence_refs: EvidenceRef[];
  confidence: string | number | null;
  proposed_operation: MemoryOperation;
  base_memory_id: string | null;
  base_revision: number | null;
  status: CandidateStatus;
  created_at: Date | string;
  observed_at: Date | string | null;
  valid_from: Date | string | null;
  valid_until: Date | string | null;
}

interface HeadRow {
  memory_id: string;
  tenant_id: string;
  life_did: string;
  memory_namespace: string;
  memory_class: MemoryClass;
  memory_kind: string;
  current_revision: number;
  status: MemoryStatus;
  created_at: Date | string;
  updated_at: Date | string;
}

interface HeadRowWithOrdinal extends HeadRow {
  ordinal: string | number;
}

interface RevisionRow {
  memory_id: string;
  revision: number;
  tenant_id: string;
  life_did: string;
  memory_namespace: string;
  memory_class: MemoryClass;
  memory_kind: string;
  status: MemoryStatus;
  canonical_text: string;
  canonical_payload: Record<string, unknown> | null;
  content_hash: string;
  author: MemoryAuthor;
  provenance: MemoryProvenance;
  observed_at: Date | string | null;
  committed_at: Date | string;
  commit_seq: string | number;
  valid_from: Date | string | null;
  valid_until: Date | string | null;
}

interface EvidenceRow {
  source_type: string;
  source_ref: string;
}

interface RevisionRowWithOrdinal extends RevisionRow {
  ordinal: string | number;
}

interface EvidenceRowWithOrdinal extends EvidenceRow {
  ordinal: string | number;
}

interface ChangeRow {
  event_id: string;
  tenant_id: string;
  life_did: string;
  memory_namespace: string;
  commit_seq: string | number;
  memory_id: string;
  operation: MemoryOperation;
  base_revision: number | null;
  new_revision: number;
  idempotency_key: string;
  author: MemoryAuthor;
  committed_at: Date | string;
  payload_hash: string;
}

interface ChangeRowWithOrdinal extends ChangeRow {
  ordinal: string | number;
}

interface OutboxRow {
  outbox_id: string;
  tenant_id: string;
  life_did: string;
  memory_namespace: string;
  commit_seq: string | number;
  memory_id: string;
  revision: number;
  operation: MemoryOperation;
  status: MemoryOutboxRecord["status"];
  attempts: number;
  claimed_by: string | null;
  claim_token: string | null;
  lease_expires_at: Date | string | null;
  next_attempt_at: Date | string | null;
  last_error: string | null;
  created_at: Date | string;
  updated_at: Date | string | null;
}

interface ProviderMaterializationRow {
  provider_name: string;
  memory_id: string;
  provider_id: string | null;
  canonical_revision: number;
  materialized_revision: number;
  status: ProviderMaterialization["status"];
  last_error: string | null;
  last_attempt: Date | string | null;
}

interface OperationsSummaryRow {
  high_watermark: string | number;
  memory_total: string | number;
  memory_active: string | number;
  memory_tombstoned: string | number;
  memory_superseded: string | number;
  outbox_pending: string | number;
  outbox_processing: string | number;
  outbox_done: string | number;
  outbox_failed: string | number;
  device_total: string | number;
  device_max_lag: string | number;
  materialization_current: string | number;
  materialization_lagging: string | number;
  materialization_failed: string | number;
  materialization_unavailable: string | number;
  materialization_rebuilding: string | number;
}

interface ConflictRow {
  conflict_id: string;
  candidate_id: string;
  tenant_id: string;
  life_did: string;
  memory_namespace: string;
  memory_id: string;
  expected_revision: number;
  current_revision: number;
  detected_at: Date | string;
}

interface DeviceCheckpointRow {
  tenant_id: string;
  life_did: string;
  memory_namespace: string;
  device_id: string;
  last_applied_commit_seq: string | number;
  last_sync_at: Date | string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function optionalIso(value: Date | string | null): string | undefined {
  return value === null ? undefined : iso(value);
}

function numberFromDb(value: string | number): number {
  return typeof value === "number" ? value : Number.parseInt(value, 10);
}

function scopeFromRow(row: {
  tenant_id: string;
  life_did: string;
  memory_namespace: string;
}): MemoryScope {
  return {
    tenantId: row.tenant_id,
    lifeDid: row.life_did,
    memoryNamespace: row.memory_namespace,
  };
}

function contentFromRow(row: {
  canonical_text: string;
  canonical_payload: Record<string, unknown> | null;
}): CanonicalContent {
  const content: CanonicalContent = { text: row.canonical_text };
  if (row.canonical_payload !== null) {
    content.payload = row.canonical_payload;
  }
  return content;
}

function candidateFromRow(row: CandidateRow): MemoryCandidate {
  const proposedContent: CanonicalContent = { text: row.proposed_text };
  if (row.proposed_payload !== null) {
    proposedContent.payload = row.proposed_payload;
  }

  const candidate: MemoryCandidate = {
    candidateId: row.candidate_id as CandidateId,
    scope: scopeFromRow(row),
    origin: row.origin,
    candidateType: row.candidate_type,
    sourceType: row.source_type,
    memoryClass: row.memory_class,
    memoryKind: row.memory_kind,
    proposedContent,
    evidenceRefs: row.evidence_refs,
    proposedOperation: row.proposed_operation,
    status: row.status,
    createdAt: iso(row.created_at),
  };

  if (row.source_id !== null) candidate.sourceId = row.source_id;
  if (row.confidence !== null) candidate.confidence = Number(row.confidence);
  if (row.base_memory_id !== null) candidate.baseMemoryId = row.base_memory_id as MemoryId;
  if (row.base_revision !== null) candidate.baseRevision = row.base_revision;
  const observedAt = optionalIso(row.observed_at);
  const validFrom = optionalIso(row.valid_from);
  const validUntil = optionalIso(row.valid_until);
  if (observedAt !== undefined) candidate.observedAt = observedAt;
  if (validFrom !== undefined) candidate.validFrom = validFrom;
  if (validUntil !== undefined) candidate.validUntil = validUntil;
  return candidate;
}

function headFromRow(row: HeadRow): CanonicalMemoryHead {
  return {
    memoryId: row.memory_id as MemoryId,
    scope: scopeFromRow(row),
    memoryClass: row.memory_class,
    memoryKind: row.memory_kind,
    currentRevision: row.current_revision,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function changeFromRow(row: ChangeRow): MemoryChangeEnvelope {
  return {
    eventId: row.event_id as MemoryChangeEnvelope["eventId"],
    scope: scopeFromRow(row),
    commitSeq: numberFromDb(row.commit_seq),
    memoryId: row.memory_id as MemoryId,
    operation: row.operation,
    baseRevision: row.base_revision,
    newRevision: row.new_revision,
    idempotencyKey: row.idempotency_key,
    author: row.author,
    committedAt: iso(row.committed_at),
    payloadHash: row.payload_hash,
  };
}

function outboxFromRow(row: OutboxRow): MemoryOutboxRecord {
  const record: MemoryOutboxRecord = {
    outboxId: row.outbox_id as MemoryOutboxRecord["outboxId"],
    scope: scopeFromRow(row),
    commitSeq: numberFromDb(row.commit_seq),
    memoryId: row.memory_id as MemoryId,
    revision: row.revision,
    operation: row.operation,
    status: row.status,
    attempts: row.attempts,
    createdAt: iso(row.created_at),
  };
  if (row.claimed_by !== null) record.claimedBy = row.claimed_by;
  if (row.claim_token !== null) record.claimToken = row.claim_token;
  const leaseExpiresAt = optionalIso(row.lease_expires_at);
  const nextAttemptAt = optionalIso(row.next_attempt_at);
  const updatedAt = optionalIso(row.updated_at);
  if (leaseExpiresAt !== undefined) record.leaseExpiresAt = leaseExpiresAt;
  if (nextAttemptAt !== undefined) record.nextAttemptAt = nextAttemptAt;
  if (row.last_error !== null) record.lastError = row.last_error;
  if (updatedAt !== undefined) record.updatedAt = updatedAt;
  return record;
}

function materializationFromRow(
  row: ProviderMaterializationRow,
): ProviderMaterialization {
  const value: ProviderMaterialization = {
    providerName: row.provider_name,
    memoryId: row.memory_id as MemoryId,
    canonicalRevision: row.canonical_revision,
    materializedRevision: row.materialized_revision,
    status: row.status,
  };
  if (row.provider_id !== null) value.providerId = row.provider_id;
  if (row.last_error !== null) value.lastError = row.last_error;
  const lastAttempt = optionalIso(row.last_attempt);
  if (lastAttempt !== undefined) value.lastAttempt = lastAttempt;
  return value;
}

function conflictFromRow(row: ConflictRow): MemoryConflict {
  return {
    conflictId: row.conflict_id as MemoryConflict["conflictId"],
    candidateId: row.candidate_id as CandidateId,
    scope: scopeFromRow(row),
    memoryId: row.memory_id as MemoryId,
    expectedRevision: row.expected_revision,
    currentRevision: row.current_revision,
    detectedAt: iso(row.detected_at),
  };
}

function deviceCheckpointFromRow(row: DeviceCheckpointRow): DeviceCheckpoint {
  return {
    scope: scopeFromRow(row),
    deviceId: row.device_id,
    lastAppliedCommitSeq: numberFromDb(row.last_applied_commit_seq),
    lastSyncAt: iso(row.last_sync_at),
  };
}

function validateCheckpointCas(
  checkpoint: DeviceCheckpoint,
  expectedLastAppliedCommitSeq: number,
): void {
  if (
    !Number.isSafeInteger(expectedLastAppliedCommitSeq) ||
    expectedLastAppliedCommitSeq < 0 ||
    !Number.isSafeInteger(checkpoint.lastAppliedCommitSeq) ||
    checkpoint.lastAppliedCommitSeq < expectedLastAppliedCommitSeq
  ) {
    throw new ValidationError(
      "Device checkpoint CAS requires non-negative safe integers and cannot move backward",
    );
  }
}

function revisionFromRow(
  row: RevisionRow,
  evidenceRefs: EvidenceRef[],
): MemoryRevision {
  const value: MemoryRevision = {
    memoryId: row.memory_id as MemoryId,
    revision: row.revision,
    scope: scopeFromRow(row),
    memoryClass: row.memory_class,
    memoryKind: row.memory_kind,
    status: row.status,
    canonicalContent: contentFromRow(row),
    contentHash: row.content_hash,
    author: row.author,
    provenance: row.provenance,
    evidenceRefs,
    committedAt: iso(row.committed_at),
    commitSeq: numberFromDb(row.commit_seq),
  };
  const observedAt = optionalIso(row.observed_at);
  const validFrom = optionalIso(row.valid_from);
  const validUntil = optionalIso(row.valid_until);
  if (observedAt !== undefined) value.observedAt = observedAt;
  if (validFrom !== undefined) value.validFrom = validFrom;
  if (validUntil !== undefined) value.validUntil = validUntil;
  return value;
}

async function readRevision(
  client: PoolClient,
  memoryId: MemoryId,
  revision: number,
): Promise<MemoryRevision | undefined> {
  const result = await client.query<RevisionRow>(
    `SELECT * FROM memory_revisions WHERE memory_id = $1 AND revision = $2`,
    [memoryId, revision],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;

  const evidenceResult = await client.query<EvidenceRow>(
    `SELECT source_type, source_ref
       FROM memory_evidence
      WHERE memory_id = $1 AND revision = $2
      ORDER BY evidence_id`,
    [memoryId, revision],
  );

  return revisionFromRow(
    row,
    evidenceResult.rows.map((evidence) => ({
      sourceType: evidence.source_type,
      sourceRef: evidence.source_ref,
    })),
  );
}

async function readHead(
  client: PoolClient,
  memoryId: MemoryId,
  lock: boolean,
): Promise<CanonicalMemoryHead | undefined> {
  const result = await client.query<HeadRow>(
    `SELECT * FROM memory_heads WHERE memory_id = $1${lock ? " FOR UPDATE" : ""}`,
    [memoryId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : headFromRow(row);
}

class PostgresTx implements CanonicalMemoryStoreTx {
  constructor(private readonly client: PoolClient) {}

  async getCandidate(candidateId: CandidateId): Promise<MemoryCandidate | undefined> {
    const result = await this.client.query<CandidateRow>(
      `SELECT * FROM memory_candidates WHERE candidate_id = $1 FOR UPDATE`,
      [candidateId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : candidateFromRow(row);
  }

  async putCandidate(candidate: MemoryCandidate): Promise<void> {
    await this.client.query(
      `INSERT INTO memory_candidates (
         candidate_id, tenant_id, life_did, memory_namespace, origin,
         candidate_type, source_type, source_id, memory_class, memory_kind,
         proposed_text, proposed_payload, evidence_refs, confidence,
         proposed_operation, base_memory_id, base_revision, status, created_at,
         observed_at, valid_from, valid_until
       ) VALUES (
         $1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16,$17,$18,$19,$20,$21,$22
       )`,
      [
        candidate.candidateId,
        candidate.scope.tenantId,
        candidate.scope.lifeDid,
        candidate.scope.memoryNamespace,
        JSON.stringify(candidate.origin),
        candidate.candidateType,
        candidate.sourceType,
        candidate.sourceId ?? null,
        candidate.memoryClass,
        candidate.memoryKind,
        candidate.proposedContent.text,
        candidate.proposedContent.payload === undefined
          ? null
          : JSON.stringify(candidate.proposedContent.payload),
        JSON.stringify(candidate.evidenceRefs),
        candidate.confidence ?? null,
        candidate.proposedOperation,
        candidate.baseMemoryId ?? null,
        candidate.baseRevision ?? null,
        candidate.status,
        candidate.createdAt,
        candidate.observedAt ?? null,
        candidate.validFrom ?? null,
        candidate.validUntil ?? null,
      ],
    );
  }

  async setCandidateStatus(
    candidateId: CandidateId,
    status: CandidateStatus,
  ): Promise<void> {
    const result = await this.client.query(
      `UPDATE memory_candidates SET status = $2 WHERE candidate_id = $1`,
      [candidateId, status],
    );
    if (result.rowCount !== 1) {
      throw new ValidationError(`Cannot update missing candidate ${candidateId}`);
    }
  }

  async getHead(memoryId: MemoryId): Promise<CanonicalMemoryHead | undefined> {
    return readHead(this.client, memoryId, true);
  }

  async putHead(head: CanonicalMemoryHead): Promise<void> {
    if (head.currentRevision === 1) {
      const result = await this.client.query(
        `INSERT INTO memory_heads (
           memory_id, tenant_id, life_did, memory_namespace, memory_class,
           memory_kind, current_revision, status, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (memory_id) DO NOTHING`,
        [
          head.memoryId,
          head.scope.tenantId,
          head.scope.lifeDid,
          head.scope.memoryNamespace,
          head.memoryClass,
          head.memoryKind,
          head.currentRevision,
          head.status,
          head.createdAt,
          head.updatedAt,
        ],
      );
      if (result.rowCount !== 1) {
        throw new ValidationError(`Canonical memory identity collision: ${head.memoryId}`);
      }
      return;
    }

    const result = await this.client.query(
      `UPDATE memory_heads
          SET current_revision = $7, status = $8, updated_at = $10
        WHERE memory_id = $1
          AND tenant_id = $2 AND life_did = $3 AND memory_namespace = $4
          AND memory_class = $5 AND memory_kind = $6
          AND current_revision = $9`,
      [
        head.memoryId,
        head.scope.tenantId,
        head.scope.lifeDid,
        head.scope.memoryNamespace,
        head.memoryClass,
        head.memoryKind,
        head.currentRevision,
        head.status,
        head.currentRevision - 1,
        head.updatedAt,
      ],
    );
    if (result.rowCount !== 1) {
      throw new ValidationError(
        `Canonical head update guard failed for ${head.memoryId} revision ${head.currentRevision}`,
      );
    }
  }

  async getRevision(
    memoryId: MemoryId,
    revision: number,
  ): Promise<MemoryRevision | undefined> {
    return readRevision(this.client, memoryId, revision);
  }

  async appendRevision(revision: MemoryRevision): Promise<void> {
    await this.client.query(
      `INSERT INTO memory_revisions (
         memory_id, revision, tenant_id, life_did, memory_namespace,
         memory_class, memory_kind, status, canonical_text, canonical_payload,
         content_hash, author, provenance, observed_at, valid_from, valid_until,
         committed_at, commit_seq
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,$13::jsonb,$14,$15,$16,$17,$18
       )`,
      [
        revision.memoryId,
        revision.revision,
        revision.scope.tenantId,
        revision.scope.lifeDid,
        revision.scope.memoryNamespace,
        revision.memoryClass,
        revision.memoryKind,
        revision.status,
        revision.canonicalContent.text,
        revision.canonicalContent.payload === undefined
          ? null
          : JSON.stringify(revision.canonicalContent.payload),
        revision.contentHash,
        JSON.stringify(revision.author),
        JSON.stringify(revision.provenance),
        revision.observedAt ?? null,
        revision.validFrom ?? null,
        revision.validUntil ?? null,
        revision.committedAt,
        revision.commitSeq,
      ],
    );

    for (const evidence of revision.evidenceRefs) {
      await this.client.query(
        `INSERT INTO memory_evidence (memory_id, revision, source_type, source_ref)
         VALUES ($1,$2,$3,$4)`,
        [revision.memoryId, revision.revision, evidence.sourceType, evidence.sourceRef],
      );
    }
  }

  async nextCommitSeq(scope: MemoryScope): Promise<number> {
    const result = await this.client.query<{ commit_seq: string | number }>(
      `SELECT next_memory_commit_seq($1,$2,$3) AS commit_seq`,
      [scope.tenantId, scope.lifeDid, scope.memoryNamespace],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new ValidationError("next_memory_commit_seq returned no value");
    }
    return numberFromDb(row.commit_seq);
  }

  async appendChange(change: MemoryChangeEnvelope): Promise<void> {
    await this.client.query(
      `INSERT INTO memory_changes (
         event_id, tenant_id, life_did, memory_namespace, commit_seq,
         memory_id, operation, base_revision, new_revision, idempotency_key,
         author, committed_at, payload_hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)`,
      [
        change.eventId,
        change.scope.tenantId,
        change.scope.lifeDid,
        change.scope.memoryNamespace,
        change.commitSeq,
        change.memoryId,
        change.operation,
        change.baseRevision,
        change.newRevision,
        change.idempotencyKey,
        JSON.stringify(change.author),
        change.committedAt,
        change.payloadHash,
      ],
    );
  }

  async appendOutbox(record: MemoryOutboxRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO memory_outbox (
         outbox_id, tenant_id, life_did, memory_namespace, commit_seq,
         memory_id, revision, operation, status, attempts, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        record.outboxId,
        record.scope.tenantId,
        record.scope.lifeDid,
        record.scope.memoryNamespace,
        record.commitSeq,
        record.memoryId,
        record.revision,
        record.operation,
        record.status,
        record.attempts,
        record.createdAt,
      ],
    );
  }

  async appendConflict(conflict: MemoryConflict): Promise<void> {
    await this.client.query(
      `INSERT INTO memory_conflicts (
         conflict_id, candidate_id, tenant_id, life_did, memory_namespace,
         memory_id, expected_revision, current_revision, detected_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        conflict.conflictId,
        conflict.candidateId,
        conflict.scope.tenantId,
        conflict.scope.lifeDid,
        conflict.scope.memoryNamespace,
        conflict.memoryId,
        conflict.expectedRevision,
        conflict.currentRevision,
        conflict.detectedAt,
      ],
    );
  }

  async getCommitResultByIdempotencyKey(
    scope: MemoryScope,
    idempotencyKey: string,
  ): Promise<CanonicalCommitResult | undefined> {
    const lockKey = `${scopeKey(scope)}\u001f${idempotencyKey}`;
    await this.client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [lockKey],
    );

    const changeResult = await this.client.query<ChangeRow>(
      `SELECT * FROM memory_changes
        WHERE tenant_id = $1 AND life_did = $2 AND memory_namespace = $3
          AND idempotency_key = $4`,
      [scope.tenantId, scope.lifeDid, scope.memoryNamespace, idempotencyKey],
    );
    const changeRow = changeResult.rows[0];
    if (changeRow === undefined) return undefined;

    const change = changeFromRow(changeRow);
    const currentHead = await readHead(this.client, change.memoryId, true);
    const revision = await readRevision(
      this.client,
      change.memoryId,
      change.newRevision,
    );
    const outboxResult = await this.client.query<OutboxRow>(
      `SELECT * FROM memory_outbox
        WHERE tenant_id = $1 AND life_did = $2 AND memory_namespace = $3
          AND commit_seq = $4`,
      [scope.tenantId, scope.lifeDid, scope.memoryNamespace, change.commitSeq],
    );
    const outboxRow = outboxResult.rows[0];

    if (currentHead === undefined || revision === undefined || outboxRow === undefined) {
      throw new ValidationError(
        `Idempotent commit ${idempotencyKey} has incomplete canonical transaction state`,
      );
    }

    const headAtCommit: CanonicalMemoryHead = {
      memoryId: currentHead.memoryId,
      scope: currentHead.scope,
      memoryClass: currentHead.memoryClass,
      memoryKind: currentHead.memoryKind,
      currentRevision: change.newRevision,
      status: revision.status,
      createdAt: currentHead.createdAt,
      updatedAt: change.committedAt,
    };

    return {
      head: headAtCommit,
      revision,
      change,
      outbox: outboxFromRow(outboxRow),
    };
  }

  async putCommitResultByIdempotencyKey(
    _scope: MemoryScope,
    _idempotencyKey: string,
    _result: CanonicalCommitResult,
  ): Promise<void> {
    // PostgreSQL persistence is already represented by memory_changes + unique
    // (scope, idempotency_key). No separate idempotency table is required.
  }
}

export class PostgresCanonicalMemoryStore implements CentralOperationsStore {
  constructor(private readonly pool: Pool) {}

  static fromConnectionString(connectionString: string): PostgresCanonicalMemoryStore {
    return new PostgresCanonicalMemoryStore(new Pool({ connectionString }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async transaction<T>(work: (tx: CanonicalMemoryStoreTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(new PostgresTx(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getCandidate(candidateId: CandidateId): Promise<MemoryCandidate | undefined> {
    const result = await this.pool.query<CandidateRow>(
      `SELECT * FROM memory_candidates WHERE candidate_id = $1`,
      [candidateId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : candidateFromRow(row);
  }

  async getHead(memoryId: MemoryId): Promise<CanonicalMemoryHead | undefined> {
    const result = await this.pool.query<HeadRow>(
      `SELECT * FROM memory_heads WHERE memory_id = $1`,
      [memoryId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : headFromRow(row);
  }

  async getHeads(
    memoryIds: readonly MemoryId[],
  ): Promise<Array<CanonicalMemoryHead | undefined>> {
    if (memoryIds.length === 0) return [];
    const result = await this.pool.query<HeadRowWithOrdinal>(
      `WITH requested AS (
         SELECT memory_id, ordinal
           FROM unnest($1::text[]) WITH ORDINALITY AS input(memory_id, ordinal)
       )
       SELECT memory_heads.*, requested.ordinal
         FROM requested
         JOIN memory_heads USING (memory_id)
        ORDER BY requested.ordinal`,
      [memoryIds],
    );
    const heads: Array<CanonicalMemoryHead | undefined> = memoryIds.map(
      () => undefined,
    );
    for (const row of result.rows) {
      heads[numberFromDb(row.ordinal) - 1] = headFromRow(row);
    }
    return heads;
  }

  async getRevision(
    memoryId: MemoryId,
    revision: number,
  ): Promise<MemoryRevision | undefined> {
    const client = await this.pool.connect();
    try {
      return await readRevision(client, memoryId, revision);
    } finally {
      client.release();
    }
  }

  async getRevisions(
    references: readonly MemoryRevisionRef[],
  ): Promise<Array<MemoryRevision | undefined>> {
    if (references.length === 0) return [];
    const memoryIds = references.map((reference) => reference.memoryId);
    const revisionNumbers = references.map((reference) => reference.revision);

    const revisionResult = await this.pool.query<RevisionRowWithOrdinal>(
      `WITH requested AS (
         SELECT memory_id, revision, ordinal
           FROM unnest($1::text[], $2::integer[])
                WITH ORDINALITY AS input(memory_id, revision, ordinal)
       )
       SELECT memory_revisions.*, requested.ordinal
         FROM requested
         JOIN memory_revisions
           ON memory_revisions.memory_id = requested.memory_id
          AND memory_revisions.revision = requested.revision
        ORDER BY requested.ordinal`,
      [memoryIds, revisionNumbers],
    );

    const evidenceResult = await this.pool.query<EvidenceRowWithOrdinal>(
      `WITH requested AS (
         SELECT memory_id, revision, ordinal
           FROM unnest($1::text[], $2::integer[])
                WITH ORDINALITY AS input(memory_id, revision, ordinal)
       )
       SELECT requested.ordinal, memory_evidence.source_type,
              memory_evidence.source_ref
         FROM requested
         JOIN memory_evidence
           ON memory_evidence.memory_id = requested.memory_id
          AND memory_evidence.revision = requested.revision
        ORDER BY requested.ordinal, memory_evidence.evidence_id`,
      [memoryIds, revisionNumbers],
    );

    const evidenceByOrdinal = new Map<number, EvidenceRef[]>();
    for (const row of evidenceResult.rows) {
      const ordinal = numberFromDb(row.ordinal);
      const evidence = evidenceByOrdinal.get(ordinal) ?? [];
      evidence.push({ sourceType: row.source_type, sourceRef: row.source_ref });
      evidenceByOrdinal.set(ordinal, evidence);
    }

    const revisions: Array<MemoryRevision | undefined> = references.map(
      () => undefined,
    );
    for (const row of revisionResult.rows) {
      const ordinal = numberFromDb(row.ordinal);
      revisions[ordinal - 1] = revisionFromRow(
        row,
        evidenceByOrdinal.get(ordinal) ?? [],
      );
    }
    return revisions;
  }

  async listChangesAfter(
    scope: MemoryScope,
    afterCommitSeq: number,
    limit?: number,
  ): Promise<MemoryChangeEnvelope[]> {
    if (
      !Number.isSafeInteger(afterCommitSeq) ||
      afterCommitSeq < 0 ||
      (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
    ) {
      throw new ValidationError(
        "Change feed cursor must be non-negative and limit must be a positive safe integer",
      );
    }
    const limitClause = limit === undefined ? "" : " LIMIT $5";
    const values: unknown[] = [
      scope.tenantId,
      scope.lifeDid,
      scope.memoryNamespace,
      afterCommitSeq,
    ];
    if (limit !== undefined) values.push(limit);
    const result = await this.pool.query<ChangeRow>(
      `SELECT * FROM memory_changes
        WHERE tenant_id = $1 AND life_did = $2 AND memory_namespace = $3
          AND commit_seq > $4
        ORDER BY commit_seq ASC${limitClause}`,
      values,
    );
    return result.rows.map(changeFromRow);
  }

  async getChangesByCommitSeqs(
    scope: MemoryScope,
    commitSeqs: readonly number[],
  ): Promise<Array<MemoryChangeEnvelope | undefined>> {
    if (commitSeqs.length === 0) return [];
    const result = await this.pool.query<ChangeRowWithOrdinal>(
      `WITH requested AS (
         SELECT commit_seq, ordinal
           FROM unnest($4::bigint[])
                WITH ORDINALITY AS input(commit_seq, ordinal)
       )
       SELECT memory_changes.*, requested.ordinal
         FROM requested
         JOIN memory_changes
           ON memory_changes.tenant_id = $1
          AND memory_changes.life_did = $2
          AND memory_changes.memory_namespace = $3
          AND memory_changes.commit_seq = requested.commit_seq
        ORDER BY requested.ordinal`,
      [
        scope.tenantId,
        scope.lifeDid,
        scope.memoryNamespace,
        commitSeqs,
      ],
    );
    const changes: Array<MemoryChangeEnvelope | undefined> = commitSeqs.map(
      () => undefined,
    );
    for (const row of result.rows) {
      changes[numberFromDb(row.ordinal) - 1] = changeFromRow(row);
    }
    return changes;
  }

  async getDeviceCheckpoint(
    scope: MemoryScope,
    deviceId: string,
  ): Promise<DeviceCheckpoint | undefined> {
    const result = await this.pool.query<DeviceCheckpointRow>(
      `SELECT * FROM device_checkpoints
        WHERE tenant_id = $1 AND life_did = $2 AND memory_namespace = $3
          AND device_id = $4`,
      [scope.tenantId, scope.lifeDid, scope.memoryNamespace, deviceId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : deviceCheckpointFromRow(row);
  }

  async compareAndSetDeviceCheckpoint(
    checkpoint: DeviceCheckpoint,
    expectedLastAppliedCommitSeq: number,
  ): Promise<boolean> {
    validateCheckpointCas(checkpoint, expectedLastAppliedCommitSeq);
    const highWatermarkResult = await this.pool.query<{
      last_commit_seq: string | number;
    }>(
      `SELECT last_commit_seq FROM memory_namespace_sequences
        WHERE tenant_id = $1 AND life_did = $2 AND memory_namespace = $3`,
      [
        checkpoint.scope.tenantId,
        checkpoint.scope.lifeDid,
        checkpoint.scope.memoryNamespace,
      ],
    );
    const highWatermarkRow = highWatermarkResult.rows[0];
    const highestCommitted =
      highWatermarkRow === undefined
        ? 0
        : numberFromDb(highWatermarkRow.last_commit_seq);
    if (checkpoint.lastAppliedCommitSeq > highestCommitted) {
      throw new ValidationError(
        "Device checkpoint cannot exceed the committed change sequence",
      );
    }
    const result = await this.pool.query<{ changed: number }>(
      `WITH updated AS (
         UPDATE device_checkpoints
            SET last_applied_commit_seq = $5, last_sync_at = $6
          WHERE tenant_id = $1 AND life_did = $2 AND memory_namespace = $3
            AND device_id = $4 AND last_applied_commit_seq = $7
         RETURNING 1 AS changed
       ), inserted AS (
         INSERT INTO device_checkpoints (
           tenant_id, life_did, memory_namespace, device_id,
           last_applied_commit_seq, last_sync_at
         )
         SELECT $1, $2, $3, $4, $5, $6
          WHERE $7 = 0
            AND NOT EXISTS (
              SELECT 1 FROM device_checkpoints
               WHERE tenant_id = $1 AND life_did = $2 AND memory_namespace = $3
                 AND device_id = $4
            )
         ON CONFLICT DO NOTHING
         RETURNING 1 AS changed
       )
       SELECT changed FROM updated
       UNION ALL
       SELECT changed FROM inserted`,
      [
        checkpoint.scope.tenantId,
        checkpoint.scope.lifeDid,
        checkpoint.scope.memoryNamespace,
        checkpoint.deviceId,
        checkpoint.lastAppliedCommitSeq,
        checkpoint.lastSyncAt,
        expectedLastAppliedCommitSeq,
      ],
    );
    return result.rowCount === 1;
  }

  async listConflicts(scope: MemoryScope): Promise<MemoryConflict[]> {
    const result = await this.pool.query<ConflictRow>(
      `SELECT * FROM memory_conflicts
        WHERE tenant_id = $1 AND life_did = $2 AND memory_namespace = $3
        ORDER BY detected_at ASC`,
      [scope.tenantId, scope.lifeDid, scope.memoryNamespace],
    );
    return result.rows.map(conflictFromRow);
  }

  async listCurrentHeadsAfter(
    scope: MemoryScope,
    afterCommitSeq: number,
    limit: number,
  ): Promise<CurrentHeadCursorRecord[]> {
    const result = await this.pool.query<HeadRow & { commit_seq: string | number }>(
      `SELECT memory_heads.*, memory_revisions.commit_seq
         FROM memory_heads
         JOIN memory_revisions
           ON memory_revisions.memory_id = memory_heads.memory_id
          AND memory_revisions.revision = memory_heads.current_revision
        WHERE memory_heads.tenant_id = $1
          AND memory_heads.life_did = $2
          AND memory_heads.memory_namespace = $3
          AND memory_revisions.commit_seq > $4
        ORDER BY memory_revisions.commit_seq ASC, memory_heads.memory_id ASC
        LIMIT $5`,
      [
        scope.tenantId,
        scope.lifeDid,
        scope.memoryNamespace,
        afterCommitSeq,
        limit,
      ],
    );
    return result.rows.map((row) => ({
      head: headFromRow(row),
      commitSeq: numberFromDb(row.commit_seq),
    }));
  }

  async getScopeHighWatermark(scope: MemoryScope): Promise<number> {
    const result = await this.pool.query<{ last_commit_seq: string | number }>(
      `SELECT last_commit_seq
         FROM memory_namespace_sequences
        WHERE tenant_id = $1 AND life_did = $2 AND memory_namespace = $3`,
      [scope.tenantId, scope.lifeDid, scope.memoryNamespace],
    );
    const row = result.rows[0];
    return row === undefined ? 0 : numberFromDb(row.last_commit_seq);
  }

  async listDeviceCheckpointsAfter(
    scope: MemoryScope,
    afterDeviceId: string | undefined,
    limit: number,
  ): Promise<DeviceCheckpoint[]> {
    const values: unknown[] = [
      scope.tenantId,
      scope.lifeDid,
      scope.memoryNamespace,
    ];
    const cursorClause = afterDeviceId === undefined ? "" : " AND device_id > $4";
    if (afterDeviceId !== undefined) values.push(afterDeviceId);
    values.push(limit);
    const limitPosition = values.length;
    const result = await this.pool.query<DeviceCheckpointRow>(
      `SELECT * FROM device_checkpoints
        WHERE tenant_id = $1 AND life_did = $2 AND memory_namespace = $3
          ${cursorClause}
        ORDER BY device_id ASC
        LIMIT $${limitPosition}`,
      values,
    );
    return result.rows.map(deviceCheckpointFromRow);
  }

  async listProviderMaterializationsAfter(
    scope: MemoryScope,
    after: ProviderMaterializationCursor | undefined,
    limit: number,
  ): Promise<ProviderMaterialization[]> {
    const values: unknown[] = [
      scope.tenantId,
      scope.lifeDid,
      scope.memoryNamespace,
    ];
    const cursorClause =
      after === undefined
        ? ""
        : " AND (provider_materializations.provider_name, provider_materializations.memory_id) > ($4, $5)";
    if (after !== undefined) {
      values.push(after.providerName, after.memoryId);
    }
    values.push(limit);
    const limitPosition = values.length;
    const result = await this.pool.query<ProviderMaterializationRow>(
      `SELECT provider_materializations.*
         FROM provider_materializations
         JOIN memory_heads
           ON memory_heads.memory_id = provider_materializations.memory_id
        WHERE memory_heads.tenant_id = $1
          AND memory_heads.life_did = $2
          AND memory_heads.memory_namespace = $3
          ${cursorClause}
        ORDER BY provider_materializations.provider_name ASC,
                 provider_materializations.memory_id ASC
        LIMIT $${limitPosition}`,
      values,
    );
    return result.rows.map(materializationFromRow);
  }

  async getNamespaceOperationsSummary(
    scope: MemoryScope,
  ): Promise<NamespaceOperationsSummary> {
    const result = await this.pool.query<OperationsSummaryRow>(
      `WITH high AS (
         SELECT COALESCE((
           SELECT last_commit_seq
             FROM memory_namespace_sequences
            WHERE tenant_id = $1 AND life_did = $2 AND memory_namespace = $3
         ), 0)::bigint AS value
       ), memory_counts AS (
         SELECT COUNT(*)::bigint AS total,
                COUNT(*) FILTER (WHERE status = 'active')::bigint AS active,
                COUNT(*) FILTER (WHERE status = 'tombstoned')::bigint AS tombstoned,
                COUNT(*) FILTER (WHERE status = 'superseded')::bigint AS superseded
           FROM memory_heads
          WHERE tenant_id = $1 AND life_did = $2 AND memory_namespace = $3
       ), outbox_counts AS (
         SELECT COUNT(*) FILTER (WHERE status = 'PENDING')::bigint AS pending,
                COUNT(*) FILTER (WHERE status = 'PROCESSING')::bigint AS processing,
                COUNT(*) FILTER (WHERE status = 'DONE')::bigint AS done,
                COUNT(*) FILTER (WHERE status = 'FAILED')::bigint AS failed
           FROM memory_outbox
          WHERE tenant_id = $1 AND life_did = $2 AND memory_namespace = $3
       ), device_counts AS (
         SELECT COUNT(*)::bigint AS total,
                COALESCE(MAX(GREATEST(high.value - last_applied_commit_seq, 0)), 0)::bigint AS max_lag
           FROM device_checkpoints CROSS JOIN high
          WHERE tenant_id = $1 AND life_did = $2 AND memory_namespace = $3
       ), materialization_counts AS (
         SELECT COUNT(*) FILTER (WHERE provider_materializations.status = 'CURRENT')::bigint AS current,
                COUNT(*) FILTER (WHERE provider_materializations.status = 'LAGGING')::bigint AS lagging,
                COUNT(*) FILTER (WHERE provider_materializations.status = 'FAILED')::bigint AS failed,
                COUNT(*) FILTER (WHERE provider_materializations.status = 'UNAVAILABLE')::bigint AS unavailable,
                COUNT(*) FILTER (WHERE provider_materializations.status = 'REBUILDING')::bigint AS rebuilding
           FROM provider_materializations
           JOIN memory_heads ON memory_heads.memory_id = provider_materializations.memory_id
          WHERE memory_heads.tenant_id = $1
            AND memory_heads.life_did = $2
            AND memory_heads.memory_namespace = $3
       )
       SELECT high.value AS high_watermark,
              memory_counts.total AS memory_total,
              memory_counts.active AS memory_active,
              memory_counts.tombstoned AS memory_tombstoned,
              memory_counts.superseded AS memory_superseded,
              outbox_counts.pending AS outbox_pending,
              outbox_counts.processing AS outbox_processing,
              outbox_counts.done AS outbox_done,
              outbox_counts.failed AS outbox_failed,
              device_counts.total AS device_total,
              device_counts.max_lag AS device_max_lag,
              materialization_counts.current AS materialization_current,
              materialization_counts.lagging AS materialization_lagging,
              materialization_counts.failed AS materialization_failed,
              materialization_counts.unavailable AS materialization_unavailable,
              materialization_counts.rebuilding AS materialization_rebuilding
         FROM high, memory_counts, outbox_counts, device_counts, materialization_counts`,
      [scope.tenantId, scope.lifeDid, scope.memoryNamespace],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new ValidationError("Namespace operations summary returned no row");
    }
    return {
      scope,
      highWatermark: numberFromDb(row.high_watermark),
      memories: {
        total: numberFromDb(row.memory_total),
        active: numberFromDb(row.memory_active),
        tombstoned: numberFromDb(row.memory_tombstoned),
        superseded: numberFromDb(row.memory_superseded),
      },
      outbox: {
        pending: numberFromDb(row.outbox_pending),
        processing: numberFromDb(row.outbox_processing),
        done: numberFromDb(row.outbox_done),
        failed: numberFromDb(row.outbox_failed),
      },
      devices: {
        total: numberFromDb(row.device_total),
        maxLag: numberFromDb(row.device_max_lag),
      },
      materializations: {
        current: numberFromDb(row.materialization_current),
        lagging: numberFromDb(row.materialization_lagging),
        failed: numberFromDb(row.materialization_failed),
        unavailable: numberFromDb(row.materialization_unavailable),
        rebuilding: numberFromDb(row.materialization_rebuilding),
      },
    };
  }

  async claimOutboxBatch(
    scope: MemoryScope,
    workerId: string,
    claimToken: string,
    claimedAt: string,
    leaseExpiresAt: string,
    limit: number,
  ): Promise<ClaimedOutboxRecord[]> {
    const result = await this.pool.query<OutboxRow>(
      `WITH claimable AS (
         SELECT candidate.outbox_id
           FROM memory_outbox AS candidate
          WHERE candidate.tenant_id = $1
            AND candidate.life_did = $2
            AND candidate.memory_namespace = $3
            AND (
              (
                candidate.status IN ('PENDING', 'FAILED')
                AND (
                  candidate.next_attempt_at IS NULL
                  OR candidate.next_attempt_at <= $4
                )
              )
              OR
              (
                candidate.status = 'PROCESSING'
                AND candidate.lease_expires_at <= $4
              )
            )
            AND NOT EXISTS (
              SELECT 1
                FROM memory_outbox AS earlier
               WHERE earlier.memory_id = candidate.memory_id
                 AND earlier.revision < candidate.revision
                 AND earlier.status <> 'DONE'
            )
          ORDER BY candidate.created_at ASC, candidate.outbox_id ASC
          LIMIT $8
          FOR UPDATE SKIP LOCKED
       )
       UPDATE memory_outbox AS outbox
          SET status = 'PROCESSING',
              attempts = outbox.attempts + 1,
              claimed_by = $5,
              claim_token = $6,
              lease_expires_at = $7,
              next_attempt_at = NULL,
              last_error = NULL,
              updated_at = $4
         FROM claimable
        WHERE outbox.outbox_id = claimable.outbox_id
       RETURNING outbox.*`,
      [
        scope.tenantId,
        scope.lifeDid,
        scope.memoryNamespace,
        claimedAt,
        workerId,
        claimToken,
        leaseExpiresAt,
        limit,
      ],
    );
    return result.rows.map((row) => {
      const record = outboxFromRow(row);
      if (
        record.status !== "PROCESSING" ||
        record.claimedBy === undefined ||
        record.claimToken === undefined ||
        record.leaseExpiresAt === undefined ||
        record.updatedAt === undefined
      ) {
        throw new ValidationError(`Claimed outbox ${record.outboxId} has no active lease`);
      }
      return record as ClaimedOutboxRecord;
    });
  }

  async settleOutboxClaim(
    request: SettleClaimRequest,
  ): Promise<SettledClaim | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const claimed = await client.query<OutboxRow>(
        `SELECT * FROM memory_outbox
          WHERE tenant_id = $1 AND life_did = $2 AND memory_namespace = $3
            AND outbox_id = $4
            AND status = 'PROCESSING'
            AND claimed_by = $5
            AND claim_token = $6
            AND lease_expires_at > $7
          FOR UPDATE`,
        [
          request.scope.tenantId,
          request.scope.lifeDid,
          request.scope.memoryNamespace,
          request.outboxId,
          request.workerId,
          request.claimToken,
          request.settledAt,
        ],
      );
      const claimedRow = claimed.rows[0];
      if (claimedRow === undefined) {
        await client.query("COMMIT");
        return undefined;
      }

      const failed = request.outcomes.filter((outcome) => outcome.status !== "CURRENT");
      const materializations: ProviderMaterialization[] = [];
      for (const outcome of request.outcomes) {
        const materializedRevision =
          outcome.status === "CURRENT" ? claimedRow.revision : 0;
        const materialization = await client.query<ProviderMaterializationRow>(
          `INSERT INTO provider_materializations (
             provider_name, memory_id, provider_id, canonical_revision,
             materialized_revision, status, last_error, last_attempt
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (provider_name, memory_id) DO UPDATE
             SET provider_id = COALESCE(
                   EXCLUDED.provider_id,
                   provider_materializations.provider_id
                 ),
                 canonical_revision = EXCLUDED.canonical_revision,
                 materialized_revision = CASE
                   WHEN EXCLUDED.status = 'CURRENT'
                   THEN EXCLUDED.materialized_revision
                   ELSE provider_materializations.materialized_revision
                 END,
                 status = EXCLUDED.status,
                 last_error = EXCLUDED.last_error,
                 last_attempt = EXCLUDED.last_attempt
           WHERE provider_materializations.canonical_revision <= EXCLUDED.canonical_revision
           RETURNING *`,
          [
            outcome.providerName,
            claimedRow.memory_id,
            outcome.providerId ?? null,
            claimedRow.revision,
            materializedRevision,
            outcome.status,
            outcome.lastError ?? null,
            request.settledAt,
          ],
        );
        const row = materialization.rows[0];
        if (row === undefined) {
          throw new ValidationError(
            `Provider materialization ${outcome.providerName} returned no row`,
          );
        }
        materializations.push(materializationFromRow(row));
      }

      const status: MemoryOutboxRecord["status"] =
        request.lastError === undefined && failed.length === 0 ? "DONE" : "FAILED";
      const lastError =
        request.lastError ??
        (failed.length === 0
          ? null
          : failed
              .map((outcome) => `${outcome.providerName}: ${outcome.lastError}`)
              .join("; "));
      const updated = await client.query<OutboxRow>(
        `UPDATE memory_outbox
            SET status = $8,
                claimed_by = NULL,
                claim_token = NULL,
                lease_expires_at = NULL,
                next_attempt_at = $9,
                last_error = $10,
                updated_at = $7
          WHERE tenant_id = $1 AND life_did = $2 AND memory_namespace = $3
            AND outbox_id = $4
            AND claimed_by = $5
            AND claim_token = $6
        RETURNING *`,
        [
          request.scope.tenantId,
          request.scope.lifeDid,
          request.scope.memoryNamespace,
          request.outboxId,
          request.workerId,
          request.claimToken,
          request.settledAt,
          status,
          request.nextAttemptAt ?? null,
          lastError,
        ],
      );
      const updatedRow = updated.rows[0];
      if (updatedRow === undefined) {
        throw new ValidationError(`Outbox settlement lost claim ${request.outboxId}`);
      }
      await client.query("COMMIT");
      return { record: outboxFromRow(updatedRow), materializations };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
