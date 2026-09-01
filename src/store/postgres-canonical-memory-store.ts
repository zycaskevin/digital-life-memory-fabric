import { Pool, type PoolClient } from "pg";
import { ValidationError } from "../domain/errors.js";
import type {
  CanonicalCommitResult,
  CanonicalContent,
  CanonicalMemoryHead,
  CandidateId,
  CandidateStatus,
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
  MemoryScope,
  MemoryStatus,
} from "../domain/types.js";
import { scopeKey } from "../domain/utils.js";
import type {
  CanonicalMemoryStore,
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
  created_at: Date | string;
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
  return {
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
    evidenceRefs: evidenceResult.rows.map((evidence) => ({
      sourceType: evidence.source_type,
      sourceRef: evidence.source_ref,
    })),
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

export class PostgresCanonicalMemoryStore implements CanonicalMemoryStore {
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

  async listChangesAfter(
    scope: MemoryScope,
    afterCommitSeq: number,
  ): Promise<MemoryChangeEnvelope[]> {
    const result = await this.pool.query<ChangeRow>(
      `SELECT * FROM memory_changes
        WHERE tenant_id = $1 AND life_did = $2 AND memory_namespace = $3
          AND commit_seq > $4
        ORDER BY commit_seq ASC`,
      [scope.tenantId, scope.lifeDid, scope.memoryNamespace, afterCommitSeq],
    );
    return result.rows.map(changeFromRow);
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
}
