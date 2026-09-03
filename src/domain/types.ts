export type CandidateId = `cand_${string}`;
export type MemoryId = `mem_${string}`;
export type EventId = `evt_${string}`;
export type OutboxId = `out_${string}`;
export type ConflictId = `conf_${string}`;

export type EpistemicStatus =
  | "observed"
  | "user_asserted"
  | "system_observed"
  | "inferred"
  | "synthesized"
  | "uncertain";

export interface MemoryProducer {
  kind: "user" | "system" | "provider" | "runtime" | "import";
  id: string;
  providerName?: string;
  adapterVersion?: string;
  providerVersion?: string;
}

export interface SourceExperienceRef {
  sourceType: string;
  sourceId: string;
  archiveRef?: string;
  checksum?: string;
}

export interface MemoryScope {
  tenantId: string;
  lifeDid: string;
  memoryNamespace: string;
}

export type MemoryClass =
  | "episode"
  | "semantic_assertion"
  | "preference"
  | "relationship_fact";

export type CandidateStatus =
  | "PENDING"
  | "ACCEPTED"
  | "REJECTED"
  | "CONFLICT"
  | "EXPIRED";

export type MemoryStatus = "active" | "tombstoned" | "superseded";

export type MemoryOperation =
  | "create"
  | "update"
  | "supersede"
  | "tombstone"
  | "restore"
  | "merge";

export interface MemoryAuthor {
  lifeDid: string;
  agentId?: string;
  runtimeId?: string;
  deviceId?: string;
}

export interface EvidenceRef {
  sourceType: string;
  sourceRef: string;
}

export interface MemoryProvenance {
  sourceType: string;
  sourceId?: string;
  candidateId: CandidateId;
  candidateFingerprint: string;
  producer: MemoryProducer;
  sourceExperienceRefs: SourceExperienceRef[];
}

export interface CanonicalContent {
  text: string;
  payload?: Record<string, unknown>;
}

export interface MemoryCandidate {
  candidateId: CandidateId;
  scope: MemoryScope;
  origin: MemoryAuthor;
  candidateType: string;
  sourceType: string;
  sourceId?: string;
  memoryClass: MemoryClass;
  memoryKind: string;
  proposedContent: CanonicalContent;
  evidenceRefs: EvidenceRef[];
  epistemicStatus: EpistemicStatus;
  confidence?: number;
  producer: MemoryProducer;
  sourceExperienceRefs: SourceExperienceRef[];
  candidateFingerprint: string;
  distillationPolicyVersion?: string;
  providerRunId?: string;
  proposedOperation: MemoryOperation;
  baseMemoryId?: MemoryId;
  baseRevision?: number;
  status: CandidateStatus;
  createdAt: string;
  observedAt?: string;
  validFrom?: string;
  validUntil?: string;
}

export interface CanonicalMemoryHead {
  memoryId: MemoryId;
  scope: MemoryScope;
  memoryClass: MemoryClass;
  memoryKind: string;
  currentRevision: number;
  status: MemoryStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryRevision {
  memoryId: MemoryId;
  revision: number;
  scope: MemoryScope;
  memoryClass: MemoryClass;
  memoryKind: string;
  status: MemoryStatus;
  canonicalContent: CanonicalContent;
  contentHash: string;
  author: MemoryAuthor;
  provenance: MemoryProvenance;
  evidenceRefs: EvidenceRef[];
  epistemicStatus: EpistemicStatus;
  producer: MemoryProducer;
  sourceExperienceRefs: SourceExperienceRef[];
  semanticFingerprint: string;
  committedAt: string;
  commitSeq: number;
  observedAt?: string;
  validFrom?: string;
  validUntil?: string;
}

export interface MemoryRevisionRef {
  memoryId: MemoryId;
  revision: number;
}

export interface MemoryChangeEnvelope {
  eventId: EventId;
  scope: MemoryScope;
  commitSeq: number;
  memoryId: MemoryId;
  operation: MemoryOperation;
  baseRevision: number | null;
  newRevision: number;
  idempotencyKey: string;
  author: MemoryAuthor;
  committedAt: string;
  payloadHash: string;
}

export interface MemoryOutboxRecord {
  outboxId: OutboxId;
  scope: MemoryScope;
  commitSeq: number;
  memoryId: MemoryId;
  revision: number;
  operation: MemoryOperation;
  status: "PENDING" | "PROCESSING" | "DONE" | "FAILED";
  attempts: number;
  createdAt: string;
  claimedBy?: string;
  claimToken?: string;
  leaseExpiresAt?: string;
  nextAttemptAt?: string;
  lastError?: string;
  updatedAt?: string;
}

export interface ProviderMaterialization {
  providerName: string;
  memoryId: MemoryId;
  providerId?: string;
  canonicalRevision: number;
  materializedRevision: number;
  status: "CURRENT" | "LAGGING" | "FAILED" | "UNAVAILABLE" | "REBUILDING";
  lastError?: string;
  lastAttempt?: string;
}

export interface DeviceCheckpoint {
  scope: MemoryScope;
  deviceId: string;
  lastAppliedCommitSeq: number;
  lastSyncAt: string;
}

export interface MemorySyncChange {
  envelope: MemoryChangeEnvelope;
  revision: MemoryRevision;
}

export interface MemoryChangePage {
  scope: MemoryScope;
  afterCommitSeq: number;
  nextCommitSeq: number;
  changes: MemorySyncChange[];
  hasMore: boolean;
}

export interface DeviceSyncPull extends MemoryChangePage {
  deviceId: string;
  lastAppliedCommitSeq: number;
}

export interface ReadChangesInput {
  scope: MemoryScope;
  afterCommitSeq: number;
  limit?: number;
}

export interface PullDeviceChangesInput {
  scope: MemoryScope;
  deviceId: string;
  limit?: number;
}

export interface AcknowledgeDeviceChangesInput {
  scope: MemoryScope;
  deviceId: string;
  expectedLastAppliedCommitSeq: number;
  appliedThroughCommitSeq: number;
}

export interface MemoryConflict {
  conflictId: ConflictId;
  candidateId: CandidateId;
  scope: MemoryScope;
  memoryId: MemoryId;
  expectedRevision: number;
  currentRevision: number;
  detectedAt: string;
}

export interface CanonicalCommitResult {
  head: CanonicalMemoryHead;
  revision: MemoryRevision;
  change: MemoryChangeEnvelope;
  outbox: MemoryOutboxRecord;
}

export interface CandidateInput {
  scope: MemoryScope;
  origin: MemoryAuthor;
  candidateType: string;
  sourceType: string;
  sourceId?: string;
  memoryClass: MemoryClass;
  memoryKind: string;
  proposedContent: CanonicalContent;
  evidenceRefs: EvidenceRef[];
  epistemicStatus?: EpistemicStatus;
  confidence?: number;
  producer?: MemoryProducer;
  sourceExperienceRefs?: SourceExperienceRef[];
  candidateFingerprint?: string;
  distillationPolicyVersion?: string;
  providerRunId?: string;
  proposedOperation: MemoryOperation;
  baseMemoryId?: MemoryId;
  baseRevision?: number;
  observedAt?: string;
  validFrom?: string;
  validUntil?: string;
}
