import { Pool, type PoolClient } from "pg";
import { SemanticReviewConflictError, ValidationError } from "../domain/errors.js";
import type {
  MemoryAuthor,
  MemoryScope,
  MemoryType,
  SemanticRelation,
} from "../domain/types.js";
import { sameScope, stableStringify } from "../domain/utils.js";
import type { CurationRecordId } from "../curation/types.js";
import type { SemanticReviewStore } from "./semantic-review-store.js";
import { normalizeSemanticReviewIdentifiers } from "./normalization.js";
import type {
  SemanticReviewCase,
  SemanticReviewCaseId,
  SemanticReviewDecision,
  SemanticReviewDecisionId,
  SemanticReviewDisposition,
  SemanticReviewEvent,
  SemanticReviewEventId,
  SemanticReviewListOptions,
  SemanticReviewStatus,
  SemanticReviewTrigger,
} from "./types.js";

interface ReviewCaseRow {
  case_id: string;
  curation_record_id: string;
  receipt_id: string;
  tenant_id: string;
  life_did: string;
  memory_namespace: string;
  trigger: SemanticReviewTrigger;
  semantic_key: string;
  semantic_policy_version: string;
  memory_type: MemoryType;
  semantic_relation: SemanticRelation | null;
  trigger_reason_codes: string[];
  status: SemanticReviewStatus;
  version: number;
  latest_decision_id: string | null;
  latest_idempotency_key: string | null;
  latest_disposition: SemanticReviewDisposition | null;
  reviewer: MemoryAuthor | null;
  decision_evidence_ids: string[] | null;
  decision_reason_codes: string[] | null;
  decided_at: Date | string | null;
  canonical_write_performed: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ReviewEventRow {
  event_id: string;
  case_id: string;
  tenant_id: string;
  life_did: string;
  memory_namespace: string;
  event_type: SemanticReviewEvent["eventType"];
  case_version: number;
  decision_id: string | null;
  idempotency_key: string | null;
  disposition: SemanticReviewDisposition | null;
  reviewer: MemoryAuthor | null;
  evidence_ids: string[] | null;
  reason_codes: string[];
  decided_at: Date | string | null;
  occurred_at: Date | string;
}

interface ReviewSourceRow {
  outcome: string;
  semantic_key: string;
  semantic_policy_version: string;
  memory_type: MemoryType;
  semantic_relation: SemanticRelation | null;
  reason_codes: string[];
}

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const scopeFrom = (row: { tenant_id: string; life_did: string; memory_namespace: string }): MemoryScope => ({
  tenantId: row.tenant_id,
  lifeDid: row.life_did,
  memoryNamespace: row.memory_namespace,
});

function decisionFrom(row: {
  latest_decision_id: string | null;
  latest_idempotency_key: string | null;
  latest_disposition: SemanticReviewDisposition | null;
  reviewer: MemoryAuthor | null;
  decision_evidence_ids: string[] | null;
  decision_reason_codes: string[] | null;
  decided_at: Date | string | null;
}): SemanticReviewDecision | undefined {
  if (row.latest_decision_id === null) return undefined;
  if (
    row.latest_idempotency_key === null || row.latest_disposition === null ||
    row.reviewer === null || row.decision_evidence_ids === null ||
    row.decision_reason_codes === null || row.decided_at === null
  ) {
    throw new ValidationError("semantic review case has an incomplete decision");
  }
  return {
    decisionId: row.latest_decision_id as SemanticReviewDecisionId,
    idempotencyKey: row.latest_idempotency_key,
    disposition: row.latest_disposition,
    reviewer: row.reviewer,
    evidenceIds: row.decision_evidence_ids,
    reasonCodes: row.decision_reason_codes,
    decidedAt: iso(row.decided_at),
  };
}

function caseFrom(row: ReviewCaseRow): SemanticReviewCase {
  if (row.canonical_write_performed) {
    throw new ValidationError(`semantic review case ${row.case_id} crossed the canonical boundary`);
  }
  const latestDecision = decisionFrom(row);
  return {
    caseId: row.case_id as SemanticReviewCaseId,
    scope: scopeFrom(row),
    curationRecordId: row.curation_record_id as CurationRecordId,
    receiptId: row.receipt_id,
    trigger: row.trigger,
    semanticKey: row.semantic_key,
    semanticPolicyVersion: row.semantic_policy_version,
    memoryType: row.memory_type,
    ...(row.semantic_relation === null ? {} : { semanticRelation: row.semantic_relation }),
    triggerReasonCodes: row.trigger_reason_codes,
    status: row.status,
    version: row.version,
    ...(latestDecision === undefined ? {} : { latestDecision }),
    canonicalWritePerformed: false,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function eventFrom(row: ReviewEventRow): SemanticReviewEvent {
  const decision = row.decision_id === null ? undefined : decisionFrom({
    latest_decision_id: row.decision_id,
    latest_idempotency_key: row.idempotency_key,
    latest_disposition: row.disposition,
    reviewer: row.reviewer,
    decision_evidence_ids: row.evidence_ids,
    decision_reason_codes: row.reason_codes,
    decided_at: row.decided_at,
  });
  return {
    eventId: row.event_id as SemanticReviewEventId,
    caseId: row.case_id as SemanticReviewCaseId,
    scope: scopeFrom(row),
    eventType: row.event_type,
    caseVersion: row.case_version,
    reasonCodes: row.reason_codes,
    ...(decision === undefined ? {} : { decision }),
    occurredAt: iso(row.occurred_at),
  };
}

function immutableCase(reviewCase: SemanticReviewCase): string {
  const {
    status: _status,
    version: _version,
    latestDecision: _latestDecision,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...immutable
  } = reviewCase;
  return stableStringify(immutable);
}

function immutableResolutionCase(reviewCase: SemanticReviewCase): string {
  const {
    status: _status,
    version: _version,
    latestDecision: _latestDecision,
    updatedAt: _updatedAt,
    ...immutable
  } = reviewCase;
  return stableStringify(immutable);
}

function sameEventIntent(left: SemanticReviewEvent, right: SemanticReviewEvent): boolean {
  const normalize = (event: SemanticReviewEvent) => ({
    caseId: event.caseId,
    scope: event.scope,
    eventType: event.eventType,
    caseVersion: event.caseVersion,
    reasonCodes: event.reasonCodes,
    decision: event.decision === undefined ? undefined : {
      decisionId: event.decision.decisionId,
      idempotencyKey: event.decision.idempotencyKey,
      disposition: event.decision.disposition,
      reviewer: event.decision.reviewer,
      evidenceIds: event.decision.evidenceIds,
      reasonCodes: event.decision.reasonCodes,
    },
  });
  return stableStringify(normalize(left)) === stableStringify(normalize(right));
}

function validateEnqueueBinding(
  reviewCase: SemanticReviewCase,
  event: SemanticReviewEvent,
): void {
  if (
    reviewCase.canonicalWritePerformed !== false ||
    reviewCase.status !== "pending" ||
    reviewCase.version !== 1 ||
    reviewCase.latestDecision !== undefined ||
    reviewCase.createdAt !== reviewCase.updatedAt ||
    event.caseId !== reviewCase.caseId ||
    !sameScope(event.scope, reviewCase.scope) ||
    event.eventType !== "enqueued" ||
    event.caseVersion !== 1 ||
    event.decision !== undefined ||
    event.occurredAt !== reviewCase.createdAt
  ) {
    throw new ValidationError("semantic review enqueue case or event is invalid");
  }
}

function validateResolutionBinding(
  caseId: SemanticReviewCaseId,
  expectedVersion: number,
  next: SemanticReviewCase,
  event: SemanticReviewEvent,
): void {
  if (next.latestDecision === undefined || event.decision === undefined) {
    throw new ValidationError("semantic review resolution requires a bound decision");
  }
  const expectedStatus = event.decision.disposition === "needs_more_evidence"
    ? "deferred"
    : "resolved";
  const expectedEventType = expectedStatus === "deferred" ? "deferred" : "resolved";
  const reviewer = event.decision.reviewer;
  const reviewerIdentified = [reviewer.agentId, reviewer.runtimeId, reviewer.deviceId]
    .some((value) => value !== undefined && value.trim().length > 0);
  if (
    next.caseId !== caseId ||
    next.canonicalWritePerformed !== false ||
    next.version !== expectedVersion + 1 ||
    next.status !== expectedStatus ||
    event.caseId !== caseId ||
    !sameScope(event.scope, next.scope) ||
    event.eventType !== expectedEventType ||
    event.caseVersion !== next.version ||
    event.decision.decisionId !== next.latestDecision.decisionId ||
    stableStringify(event.decision) !== stableStringify(next.latestDecision) ||
    stableStringify(event.reasonCodes) !== stableStringify(event.decision.reasonCodes) ||
    reviewer.lifeDid !== next.scope.lifeDid ||
    !reviewerIdentified ||
    !event.decision.evidenceIds.includes(`curation:${next.curationRecordId}`) ||
    event.occurredAt !== next.updatedAt ||
    event.decision.decidedAt !== next.updatedAt
  ) {
    throw new ValidationError("semantic review resolution case or event is invalid");
  }
}

async function readCase(
  client: Pool | PoolClient,
  scope: MemoryScope,
  caseId: SemanticReviewCaseId,
): Promise<SemanticReviewCase | undefined> {
  const result = await client.query<ReviewCaseRow>(
    `SELECT * FROM semantic_review_cases
      WHERE case_id=$1 AND tenant_id=$2 AND life_did=$3 AND memory_namespace=$4`,
    [caseId, scope.tenantId, scope.lifeDid, scope.memoryNamespace],
  );
  return result.rows[0] === undefined ? undefined : caseFrom(result.rows[0]);
}

export class PostgresSemanticReviewStore implements SemanticReviewStore {
  constructor(private readonly pool: Pool) {}

  async enqueue(reviewCase: SemanticReviewCase, event: SemanticReviewEvent): Promise<SemanticReviewCase> {
    validateEnqueueBinding(reviewCase, event);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const sourceResult = await client.query<ReviewSourceRow>(
        `SELECT outcome, semantic_key, semantic_policy_version, memory_type,
                semantic_relation, reason_codes
           FROM memory_curation_records
          WHERE record_id=$1 AND receipt_id=$2
            AND tenant_id=$3 AND life_did=$4 AND memory_namespace=$5`,
        [
          reviewCase.curationRecordId, reviewCase.receiptId,
          reviewCase.scope.tenantId, reviewCase.scope.lifeDid,
          reviewCase.scope.memoryNamespace,
        ],
      );
      const source = sourceResult.rows[0];
      const triggerMatches = source !== undefined && (
        (reviewCase.trigger === "pending_review" && source.outcome === "pending_review") ||
        (reviewCase.trigger === "canary_sample" && source.outcome !== "pending_review")
      );
      if (
        source === undefined || !triggerMatches ||
        source.semantic_key !== reviewCase.semanticKey ||
        source.semantic_policy_version !== reviewCase.semanticPolicyVersion ||
        source.memory_type !== reviewCase.memoryType ||
        source.semantic_relation !== (reviewCase.semanticRelation ?? null) ||
        stableStringify(normalizeSemanticReviewIdentifiers(source.reason_codes)) !==
          stableStringify(normalizeSemanticReviewIdentifiers(reviewCase.triggerReasonCodes))
      ) {
        throw new ValidationError("semantic review case does not match its governed curation record");
      }
      await client.query(
        `INSERT INTO semantic_review_cases (
           case_id, curation_record_id, receipt_id, tenant_id, life_did,
           memory_namespace, trigger, semantic_key, semantic_policy_version,
           memory_type, semantic_relation, trigger_reason_codes, status, version,
           canonical_write_performed, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::text[],$13,$14,$15,$16,$17)
         ON CONFLICT (curation_record_id) DO NOTHING`,
        [
          reviewCase.caseId, reviewCase.curationRecordId, reviewCase.receiptId,
          reviewCase.scope.tenantId, reviewCase.scope.lifeDid, reviewCase.scope.memoryNamespace,
          reviewCase.trigger, reviewCase.semanticKey, reviewCase.semanticPolicyVersion,
          reviewCase.memoryType, reviewCase.semanticRelation ?? null,
          reviewCase.triggerReasonCodes, reviewCase.status, reviewCase.version,
          reviewCase.canonicalWritePerformed, reviewCase.createdAt, reviewCase.updatedAt,
        ],
      );
      const existingResult = await client.query<ReviewCaseRow>(
        `SELECT * FROM semantic_review_cases WHERE curation_record_id=$1 FOR UPDATE`,
        [reviewCase.curationRecordId],
      );
      const row = existingResult.rows[0];
      if (row === undefined) throw new ValidationError("semantic review enqueue did not persist a case");
      const existing = caseFrom(row);
      if (immutableCase(existing) !== immutableCase(reviewCase)) {
        throw new ValidationError("semantic review enqueue changed immutable case fields");
      }
      await client.query(
        `INSERT INTO semantic_review_events (
           event_id, case_id, tenant_id, life_did, memory_namespace,
           event_type, case_version, reason_codes, occurred_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9)
         ON CONFLICT (event_id) DO NOTHING`,
        [
          event.eventId, event.caseId, event.scope.tenantId, event.scope.lifeDid,
          event.scope.memoryNamespace, event.eventType, event.caseVersion,
          event.reasonCodes, event.occurredAt,
        ],
      );
      const eventResult = await client.query<ReviewEventRow>(
        `SELECT * FROM semantic_review_events WHERE event_id=$1`,
        [event.eventId],
      );
      const eventRow = eventResult.rows[0];
      if (eventRow === undefined || !sameEventIntent(eventFrom(eventRow), event)) {
        throw new ValidationError("semantic review enqueue event changed immutable fields");
      }
      await client.query("COMMIT");
      return existing;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async get(scope: MemoryScope, caseId: SemanticReviewCaseId): Promise<SemanticReviewCase | undefined> {
    return readCase(this.pool, scope, caseId);
  }

  async listByReceipt(scope: MemoryScope, receiptId: string): Promise<SemanticReviewCase[]> {
    const result = await this.pool.query<ReviewCaseRow>(
      `SELECT * FROM semantic_review_cases
        WHERE receipt_id=$1 AND tenant_id=$2 AND life_did=$3 AND memory_namespace=$4
        ORDER BY case_id`,
      [receiptId, scope.tenantId, scope.lifeDid, scope.memoryNamespace],
    );
    return result.rows.map(caseFrom);
  }

  async list(
    scope: MemoryScope,
    options: SemanticReviewListOptions = {},
  ): Promise<SemanticReviewCase[]> {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new ValidationError("semantic review list limit must be between 1 and 1000");
    }
    const result = await this.pool.query<ReviewCaseRow>(
      `SELECT * FROM semantic_review_cases
        WHERE tenant_id=$1 AND life_did=$2 AND memory_namespace=$3
          AND ($4::text IS NULL OR status=$4)
        ORDER BY created_at, case_id LIMIT $5`,
      [scope.tenantId, scope.lifeDid, scope.memoryNamespace, options.status ?? null, limit],
    );
    return result.rows.map(caseFrom);
  }

  async getEventByIdempotencyKey(
    scope: MemoryScope,
    idempotencyKey: string,
  ): Promise<SemanticReviewEvent | undefined> {
    const result = await this.pool.query<ReviewEventRow>(
      `SELECT * FROM semantic_review_events
        WHERE tenant_id=$1 AND life_did=$2 AND memory_namespace=$3
          AND idempotency_key=$4`,
      [scope.tenantId, scope.lifeDid, scope.memoryNamespace, idempotencyKey],
    );
    return result.rows[0] === undefined ? undefined : eventFrom(result.rows[0]);
  }

  async resolve(
    caseId: SemanticReviewCaseId,
    expectedVersion: number,
    next: SemanticReviewCase,
    event: SemanticReviewEvent,
  ): Promise<SemanticReviewCase> {
    validateResolutionBinding(caseId, expectedVersion, next, event);
    const decision = next.latestDecision;
    const eventDecision = event.decision;
    if (decision === undefined || eventDecision === undefined) {
      throw new ValidationError("semantic review resolution requires a bound decision");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const currentResult = await client.query<ReviewCaseRow>(
        `SELECT * FROM semantic_review_cases
          WHERE case_id=$1 AND tenant_id=$2 AND life_did=$3 AND memory_namespace=$4
          FOR UPDATE`,
        [caseId, next.scope.tenantId, next.scope.lifeDid, next.scope.memoryNamespace],
      );
      const row = currentResult.rows[0];
      if (row === undefined) throw new ValidationError(`semantic review case ${caseId} was not found`);
      const current = caseFrom(row);
      const priorResult = await client.query<ReviewEventRow>(
        `SELECT * FROM semantic_review_events
          WHERE tenant_id=$1 AND life_did=$2 AND memory_namespace=$3
            AND idempotency_key=$4`,
        [
          current.scope.tenantId, current.scope.lifeDid, current.scope.memoryNamespace,
          eventDecision.idempotencyKey,
        ],
      );
      const priorRow = priorResult.rows[0];
      if (priorRow !== undefined) {
        const prior = eventFrom(priorRow);
        if (!sameEventIntent(prior, event)) {
          throw new ValidationError("semantic review idempotency key already exists");
        }
        await client.query("COMMIT");
        return current;
      }
      if (current.version !== expectedVersion) {
        throw new SemanticReviewConflictError(caseId, expectedVersion, current.version);
      }
      if (
        !sameScope(current.scope, next.scope) ||
        immutableResolutionCase(current) !== immutableResolutionCase(next) ||
        next.updatedAt < current.updatedAt
      ) {
        throw new ValidationError("semantic review resolution changed immutable case fields");
      }
      await client.query(
        `UPDATE semantic_review_cases SET
           status=$2, version=$3, latest_decision_id=$4, latest_idempotency_key=$5,
           latest_disposition=$6, reviewer=$7::jsonb,
           decision_evidence_ids=$8::text[], decision_reason_codes=$9::text[],
           decided_at=$10, updated_at=$11
         WHERE case_id=$1`,
        [
          caseId, next.status, next.version, decision.decisionId,
          decision.idempotencyKey, decision.disposition,
          JSON.stringify(decision.reviewer), decision.evidenceIds,
          decision.reasonCodes, decision.decidedAt, next.updatedAt,
        ],
      );
      await client.query(
        `INSERT INTO semantic_review_events (
           event_id, case_id, tenant_id, life_did, memory_namespace,
           event_type, case_version, decision_id, idempotency_key, disposition,
           reviewer, evidence_ids, reason_codes, decided_at, occurred_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::text[],$13::text[],$14,$15)`,
        [
          event.eventId, event.caseId, event.scope.tenantId, event.scope.lifeDid,
          event.scope.memoryNamespace, event.eventType, event.caseVersion,
          eventDecision.decisionId, eventDecision.idempotencyKey,
          eventDecision.disposition, JSON.stringify(eventDecision.reviewer),
          eventDecision.evidenceIds, event.reasonCodes, eventDecision.decidedAt,
          event.occurredAt,
        ],
      );
      await client.query("COMMIT");
      return next;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listEvents(scope: MemoryScope, caseId: SemanticReviewCaseId): Promise<SemanticReviewEvent[]> {
    const result = await this.pool.query<ReviewEventRow>(
      `SELECT * FROM semantic_review_events
        WHERE case_id=$1 AND tenant_id=$2 AND life_did=$3 AND memory_namespace=$4
        ORDER BY case_version`,
      [caseId, scope.tenantId, scope.lifeDid, scope.memoryNamespace],
    );
    return result.rows.map(eventFrom);
  }
}
