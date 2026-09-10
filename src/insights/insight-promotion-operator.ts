import { Pool } from "pg";
import { ValidationError } from "../domain/errors.js";
import type { MemoryAuthor, MemoryScope } from "../domain/types.js";
import {
  SystemClock,
  sameScope,
  sha256,
  stableStringify,
  type Clock,
} from "../domain/utils.js";
import type { InsightPromotionRecordStore } from "./insight-promotion-record-store.js";
import {
  ReflectiveInsightPromotionService,
  type InsightPromotionApprovalVerifier,
  type ReflectiveInsightPromotionServiceDependencies,
} from "./reflective-insight-promotion-service.js";
import type { ReflectiveInsightStore } from "./reflective-insight-store.js";
import type {
  InsightPromotionEvent,
  InsightPromotionPreflight,
  InsightPromotionRequest,
  InsightPromotionResult,
  ReflectiveInsight,
  ReflectiveInsightId,
} from "./types.js";
import type { CanonicalMemoryStore } from "../store/canonical-memory-store.js";

export const INSIGHT_PROMOTION_PLAN_VERSION = "dlmf.insight-promotion-plan.v1" as const;
export const INSIGHT_PROMOTION_APPROVAL_VERSION =
  "dlmf.insight-promotion-approval.v1" as const;

export interface InsightPromotionStateSnapshot {
  candidates: number;
  heads: number;
  revisions: number;
  changes: number;
  promotions: number;
  promotionEvents: number;
}

export interface InsightPromotionStateReader {
  snapshot(scope: MemoryScope): Promise<InsightPromotionStateSnapshot>;
}

export interface InsightPromotionPlan {
  formatVersion: typeof INSIGHT_PROMOTION_PLAN_VERSION;
  planId: `promplan_${string}`;
  scope: MemoryScope;
  insightId: ReflectiveInsightId;
  promotionPolicyVersion: string;
  insightFingerprint: string;
  currentStatus: "pending";
  eligibility: InsightPromotionPreflight["eligibility"];
  memoryType: InsightPromotionPreflight["memoryType"];
  semanticKey: string;
  expectedOperation: InsightPromotionPreflight["expectedOperation"];
  baseMemoryId?: InsightPromotionPreflight["baseMemoryId"];
  baseRevision?: number;
  supportingRevisions: InsightPromotionPreflight["supportingRevisions"];
  stateBefore: InsightPromotionStateSnapshot;
  createdAt: string;
  expiresAt: string;
  automaticPromotionEnabled: false;
  automaticPruningEnabled: false;
  planChecksum: string;
}

export interface InsightPromotionApprovalManifest {
  formatVersion: typeof INSIGHT_PROMOTION_APPROVAL_VERSION;
  planId: InsightPromotionPlan["planId"];
  planChecksum: string;
  decision: "accept";
  reviewedBy: MemoryAuthor;
  approvalEvidenceIds: string[];
  idempotencyKey: string;
  issuedAt: string;
  expiresAt: string;
  manifestChecksum: string;
}

export interface InsightPromotionDryRunReport {
  mode: "dry_run";
  planId: InsightPromotionPlan["planId"];
  planChecksum: string;
  manifestChecksum: string;
  checkedAt: string;
  state: InsightPromotionStateSnapshot;
  eligible: true;
  canonicalWritePerformed: false;
  automaticPromotionEnabled: false;
  automaticPruningEnabled: false;
}

export interface InsightPromotionApplyReport {
  mode: "apply";
  planId: InsightPromotionPlan["planId"];
  planChecksum: string;
  manifestChecksum: string;
  appliedAt: string;
  replay: boolean;
  promotionId: string;
  canonicalMemoryId: string;
  eventTypes: InsightPromotionEvent["eventType"][];
  stateBefore: InsightPromotionStateSnapshot;
  stateAfter: InsightPromotionStateSnapshot;
  stateDelta: InsightPromotionStateSnapshot;
  promotionCanonicalCommitPerformed: boolean;
  reflectiveInsightCanonicalWritePerformed: false;
  automaticPromotionEnabled: false;
  automaticPruningEnabled: false;
}

export interface InsightPromotionOperatorDependencies
  extends Omit<ReflectiveInsightPromotionServiceDependencies, "approvalVerifier"> {
  stateReader: InsightPromotionStateReader;
}

function asInstant(value: string, field: string): number {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) throw new ValidationError(`${field} must be an ISO timestamp`);
  return instant;
}

function requireText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new ValidationError(`${field} must be a non-empty trimmed string`);
  }
}

function requireEvidenceIds(values: string[]): void {
  if (!Array.isArray(values) || values.length === 0) {
    throw new ValidationError("approvalEvidenceIds must not be empty");
  }
  if (new Set(values).size !== values.length) {
    throw new ValidationError("approvalEvidenceIds must be unique");
  }
  for (const value of values) {
    requireText(value, "approvalEvidenceId");
    const separator = value.indexOf(":");
    const sourceType = value.slice(0, separator);
    const sourceRef = value.slice(separator + 1);
    if (separator <= 0 || separator === value.length - 1 ||
        sourceType !== sourceType.trim() || sourceRef !== sourceRef.trim()) {
      throw new ValidationError(`approvalEvidenceId ${value} must be sourceType:sourceRef`);
    }
  }
}

function planPayload(plan: InsightPromotionPlan): Omit<InsightPromotionPlan, "planChecksum"> {
  const { planChecksum: _checksum, ...payload } = plan;
  return payload;
}

function manifestPayload(
  manifest: InsightPromotionApprovalManifest,
): Omit<InsightPromotionApprovalManifest, "manifestChecksum"> {
  const { manifestChecksum: _checksum, ...payload } = manifest;
  return payload;
}

export function insightPromotionPlanChecksum(plan: InsightPromotionPlan): string {
  return sha256(planPayload(plan));
}

export function insightPromotionManifestChecksum(
  manifest: InsightPromotionApprovalManifest,
): string {
  return sha256(manifestPayload(manifest));
}

export function sealInsightPromotionApprovalManifest(
  input: Omit<InsightPromotionApprovalManifest, "manifestChecksum">,
): InsightPromotionApprovalManifest {
  const unsealed = { ...input, manifestChecksum: "" };
  return { ...unsealed, manifestChecksum: insightPromotionManifestChecksum(unsealed) };
}

function difference(
  after: InsightPromotionStateSnapshot,
  before: InsightPromotionStateSnapshot,
): InsightPromotionStateSnapshot {
  return {
    candidates: after.candidates - before.candidates,
    heads: after.heads - before.heads,
    revisions: after.revisions - before.revisions,
    changes: after.changes - before.changes,
    promotions: after.promotions - before.promotions,
    promotionEvents: after.promotionEvents - before.promotionEvents,
  };
}

function expectedDelta(
  operation: InsightPromotionPlan["expectedOperation"],
  replay: boolean,
): InsightPromotionStateSnapshot {
  if (replay) {
    return { candidates: 0, heads: 0, revisions: 0, changes: 0, promotions: 0, promotionEvents: 0 };
  }
  return {
    candidates: 1,
    heads: operation === "create" ? 1 : 0,
    revisions: 1,
    changes: 1,
    promotions: 1,
    promotionEvents: 3,
  };
}

function preflightProjection(preflight: InsightPromotionPreflight): object {
  const {
    assessedAt: _assessedAt,
    ...projection
  } = preflight;
  return projection;
}

function planProjection(plan: InsightPromotionPlan): object {
  const base = {
    insightId: plan.insightId,
    scope: plan.scope,
    currentStatus: plan.currentStatus,
    insightFingerprint: plan.insightFingerprint,
    promotionPolicyVersion: plan.promotionPolicyVersion,
    eligibility: plan.eligibility,
    memoryType: plan.memoryType,
    semanticKey: plan.semanticKey,
    expectedOperation: plan.expectedOperation,
    supportingRevisions: plan.supportingRevisions,
  };
  return plan.baseMemoryId === undefined
    ? base
    : { ...base, baseMemoryId: plan.baseMemoryId, baseRevision: plan.baseRevision };
}

export class PostgresInsightPromotionStateReader implements InsightPromotionStateReader {
  constructor(private readonly pool: Pool) {}

  async snapshot(scope: MemoryScope): Promise<InsightPromotionStateSnapshot> {
    const result = await this.pool.query<InsightPromotionStateSnapshot>(
      `SELECT
        (SELECT count(*)::int FROM memory_candidates WHERE tenant_id=$1 AND life_did=$2 AND memory_namespace=$3) AS candidates,
        (SELECT count(*)::int FROM memory_heads WHERE tenant_id=$1 AND life_did=$2 AND memory_namespace=$3) AS heads,
        (SELECT count(*)::int FROM memory_revisions WHERE tenant_id=$1 AND life_did=$2 AND memory_namespace=$3) AS revisions,
        (SELECT count(*)::int FROM memory_changes WHERE tenant_id=$1 AND life_did=$2 AND memory_namespace=$3) AS changes,
        (SELECT count(*)::int FROM insight_promotion_records WHERE tenant_id=$1 AND life_did=$2 AND memory_namespace=$3) AS promotions,
        (SELECT count(*)::int FROM insight_promotion_events WHERE tenant_id=$1 AND life_did=$2 AND memory_namespace=$3) AS "promotionEvents"`,
      [scope.tenantId, scope.lifeDid, scope.memoryNamespace],
    );
    const row = result.rows[0];
    if (row === undefined) throw new ValidationError("promotion state query returned no row");
    return row;
  }
}

/** DLMF-owned, explicit operator. It never delegates authority to the derivation provider. */
export class InsightPromotionOperator {
  private readonly clock: Clock;
  private readonly preflightService: ReflectiveInsightPromotionService;

  constructor(private readonly dependencies: InsightPromotionOperatorDependencies) {
    this.clock = dependencies.clock ?? new SystemClock();
    this.preflightService = this.service({ verifyApproval: async () => false });
  }

  async createPlan(input: {
    scope: MemoryScope;
    insightId: ReflectiveInsightId;
    expiresInMs?: number;
  }): Promise<InsightPromotionPlan> {
    const expiresInMs = input.expiresInMs ?? 15 * 60 * 1000;
    if (!Number.isSafeInteger(expiresInMs) || expiresInMs <= 0) {
      throw new ValidationError("expiresInMs must be a positive safe integer");
    }
    const governed = await this.dependencies.promotionStore.getByInsightId(
      input.scope,
      input.insightId,
    );
    if (governed !== undefined) {
      throw new ValidationError(`reflective insight already has governed promotion ${governed.promotionId}`);
    }
    const preflight = await this.preflightService.preflight(input.scope, input.insightId);
    if (preflight.currentStatus !== "pending") {
      throw new ValidationError("operator plans require a pending reflective insight");
    }
    if (!preflight.eligibility.eligible || !preflight.eligibility.evidenceClosure) {
      throw new ValidationError(
        `insight is not promotion eligible: ${preflight.eligibility.reasonCodes.join(",")}`,
      );
    }
    const createdAt = this.clock.now();
    const stateBefore = await this.dependencies.stateReader.snapshot(input.scope);
    const base = {
      formatVersion: INSIGHT_PROMOTION_PLAN_VERSION,
      scope: input.scope,
      insightId: input.insightId,
      promotionPolicyVersion: preflight.promotionPolicyVersion,
      insightFingerprint: preflight.insightFingerprint,
      currentStatus: "pending" as const,
      eligibility: preflight.eligibility,
      memoryType: preflight.memoryType,
      semanticKey: preflight.semanticKey,
      expectedOperation: preflight.expectedOperation,
      ...(preflight.baseMemoryId === undefined
        ? {}
        : { baseMemoryId: preflight.baseMemoryId, baseRevision: preflight.baseRevision }),
      supportingRevisions: preflight.supportingRevisions,
      stateBefore,
      createdAt,
      expiresAt: new Date(asInstant(createdAt, "createdAt") + expiresInMs).toISOString(),
      automaticPromotionEnabled: false as const,
      automaticPruningEnabled: false as const,
    };
    const planId = `promplan_${sha256(base).slice("sha256:".length, "sha256:".length + 32)}` as const;
    const unsealed: InsightPromotionPlan = { ...base, planId, planChecksum: "" };
    return { ...unsealed, planChecksum: insightPromotionPlanChecksum(unsealed) };
  }

  async dryRun(
    plan: InsightPromotionPlan,
    manifest: InsightPromotionApprovalManifest,
  ): Promise<InsightPromotionDryRunReport> {
    await this.validateCurrent(plan, manifest);
    return {
      mode: "dry_run",
      planId: plan.planId,
      planChecksum: plan.planChecksum,
      manifestChecksum: manifest.manifestChecksum,
      checkedAt: this.clock.now(),
      state: await this.dependencies.stateReader.snapshot(plan.scope),
      eligible: true,
      canonicalWritePerformed: false,
      automaticPromotionEnabled: false,
      automaticPruningEnabled: false,
    };
  }

  async apply(
    plan: InsightPromotionPlan,
    manifest: InsightPromotionApprovalManifest,
  ): Promise<InsightPromotionApplyReport> {
    this.validateDocuments(plan, manifest);
    const before = await this.dependencies.stateReader.snapshot(plan.scope);
    const prior = await this.dependencies.promotionStore.getByIdempotencyKey(
      plan.scope,
      manifest.idempotencyKey,
    );
    const replay = prior?.status === "committed";
    if (!replay) await this.validateCurrent(plan, manifest, before);

    const approvalEvidenceIds = [
      ...manifest.approvalEvidenceIds,
      `approval_manifest:${manifest.manifestChecksum}`,
    ];
    const request: InsightPromotionRequest = {
      insightId: plan.insightId,
      scope: plan.scope,
      approvedBy: manifest.reviewedBy,
      approvalEvidenceIds,
      idempotencyKey: manifest.idempotencyKey,
    };
    const verifier: InsightPromotionApprovalVerifier = {
      verifyApproval: async (input) =>
        input.promotionPolicyVersion === plan.promotionPolicyVersion &&
        input.insight.insightId === plan.insightId &&
        sameScope(input.insight.scope, plan.scope) &&
        sha256({
          insight: input.insight,
          promotionPolicyVersion: input.promotionPolicyVersion,
        }) === plan.insightFingerprint &&
        stableStringify(input.request) === stableStringify(request),
    };
    const result = await this.service(verifier).promote(request);
    const after = await this.dependencies.stateReader.snapshot(plan.scope);
    const stateDelta = difference(after, before);
    const expected = expectedDelta(plan.expectedOperation, replay);
    if (stableStringify(stateDelta) !== stableStringify(expected)) {
      throw new ValidationError(
        `promotion state delta did not match plan: expected=${stableStringify(expected)} actual=${stableStringify(stateDelta)}`,
      );
    }
    const events = await this.dependencies.promotionStore.listEvents(
      plan.scope,
      result.record.promotionId,
    );
    if (stableStringify(events.map((event) => event.eventType)) !==
        stableStringify(["approved", "candidate_linked", "committed"])) {
      throw new ValidationError("promotion audit event closure is incomplete");
    }
    if (result.insight.canonicalWritePerformed !== false) {
      throw new ValidationError("reflective insight canonicalWritePerformed invariant failed");
    }
    return this.applyReport(plan, manifest, result, events, before, after, stateDelta, replay);
  }

  private async validateCurrent(
    plan: InsightPromotionPlan,
    manifest: InsightPromotionApprovalManifest,
    state?: InsightPromotionStateSnapshot,
  ): Promise<void> {
    this.validateDocuments(plan, manifest);
    const currentState = state ?? await this.dependencies.stateReader.snapshot(plan.scope);
    if (stableStringify(currentState) !== stableStringify(plan.stateBefore)) {
      throw new ValidationError("promotion plan is stale because governed state changed");
    }
    const preflight = await this.preflightService.preflight(plan.scope, plan.insightId);
    if (stableStringify(preflightProjection(preflight)) !== stableStringify(planProjection(plan))) {
      throw new ValidationError("promotion plan is stale because insight or canonical support changed");
    }
  }

  private validateDocuments(
    plan: InsightPromotionPlan,
    manifest: InsightPromotionApprovalManifest,
  ): void {
    if (plan.formatVersion !== INSIGHT_PROMOTION_PLAN_VERSION) {
      throw new ValidationError("unsupported insight promotion plan format");
    }
    if (plan.planChecksum !== insightPromotionPlanChecksum(plan)) {
      throw new ValidationError("insight promotion plan checksum mismatch");
    }
    if (manifest.formatVersion !== INSIGHT_PROMOTION_APPROVAL_VERSION) {
      throw new ValidationError("unsupported insight promotion approval format");
    }
    if (manifest.manifestChecksum !== insightPromotionManifestChecksum(manifest)) {
      throw new ValidationError("insight promotion approval checksum mismatch");
    }
    if (manifest.planId !== plan.planId || manifest.planChecksum !== plan.planChecksum) {
      throw new ValidationError("approval manifest is not bound to this promotion plan");
    }
    if (manifest.decision !== "accept") throw new ValidationError("promotion approval must explicitly accept");
    requireText(manifest.idempotencyKey, "idempotencyKey");
    requireEvidenceIds(manifest.approvalEvidenceIds);
    if (manifest.reviewedBy.lifeDid !== plan.scope.lifeDid) {
      throw new ValidationError("reviewedBy.lifeDid must match the promotion scope");
    }
    if (![manifest.reviewedBy.agentId, manifest.reviewedBy.runtimeId, manifest.reviewedBy.deviceId]
      .some((value) => typeof value === "string" && value.trim().length > 0)) {
      throw new ValidationError("reviewedBy requires an identified agent, runtime, or device");
    }
    const now = asInstant(this.clock.now(), "now");
    const planCreated = asInstant(plan.createdAt, "plan.createdAt");
    const planExpires = asInstant(plan.expiresAt, "plan.expiresAt");
    const issued = asInstant(manifest.issuedAt, "manifest.issuedAt");
    const expires = asInstant(manifest.expiresAt, "manifest.expiresAt");
    if (planExpires <= planCreated || now > planExpires) {
      throw new ValidationError("insight promotion plan is expired or has an invalid lifetime");
    }
    if (expires <= issued || now < issued || now > expires || issued < planCreated || expires > planExpires) {
      throw new ValidationError("approval manifest lifetime is invalid or outside the plan lifetime");
    }
  }

  private service(approvalVerifier: InsightPromotionApprovalVerifier): ReflectiveInsightPromotionService {
    const dependencies: ReflectiveInsightPromotionServiceDependencies = {
      canonicalStore: this.dependencies.canonicalStore,
      insightStore: this.dependencies.insightStore,
      promotionStore: this.dependencies.promotionStore,
      approvalVerifier,
    };
    if (this.dependencies.candidateService !== undefined) dependencies.candidateService = this.dependencies.candidateService;
    if (this.dependencies.authority !== undefined) dependencies.authority = this.dependencies.authority;
    if (this.dependencies.semanticGovernance !== undefined) dependencies.semanticGovernance = this.dependencies.semanticGovernance;
    if (this.dependencies.promotionGate !== undefined) dependencies.promotionGate = this.dependencies.promotionGate;
    if (this.dependencies.clock !== undefined) dependencies.clock = this.dependencies.clock;
    if (this.dependencies.promotionPolicyVersion !== undefined) {
      dependencies.promotionPolicyVersion = this.dependencies.promotionPolicyVersion;
    }
    return new ReflectiveInsightPromotionService(dependencies);
  }

  private applyReport(
    plan: InsightPromotionPlan,
    manifest: InsightPromotionApprovalManifest,
    result: InsightPromotionResult,
    events: InsightPromotionEvent[],
    before: InsightPromotionStateSnapshot,
    after: InsightPromotionStateSnapshot,
    stateDelta: InsightPromotionStateSnapshot,
    replay: boolean,
  ): InsightPromotionApplyReport {
    return {
      mode: "apply",
      planId: plan.planId,
      planChecksum: plan.planChecksum,
      manifestChecksum: manifest.manifestChecksum,
      appliedAt: this.clock.now(),
      replay,
      promotionId: result.record.promotionId,
      canonicalMemoryId: result.canonicalMemoryId,
      eventTypes: events.map((event) => event.eventType),
      stateBefore: before,
      stateAfter: after,
      stateDelta,
      promotionCanonicalCommitPerformed: !replay,
      reflectiveInsightCanonicalWritePerformed: false,
      automaticPromotionEnabled: false,
      automaticPruningEnabled: false,
    };
  }
}
