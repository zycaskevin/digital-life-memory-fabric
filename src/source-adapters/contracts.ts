export type ExperienceId = `exp_${string}`;

/** Stable identity of one external source object. Mutable version data is separate. */
export interface SourceIdentity {
  sourceSystem: string;
  sourceType: string;
  sourceId: string;
}

/** Version observed when the source was read. It MUST NOT participate in stable identity. */
export interface SourceVersion {
  value: string;
  scheme: "native" | "etag" | "mtime" | "revision" | "synthetic" | "unknown";
}

export interface SourceFingerprint {
  algorithm: "sha256";
  value: string;
}

export type TemporalCertainty = "exact" | "inferred" | "unknown";

export interface ExperienceTimestamp {
  value?: string;
  certainty: TemporalCertainty;
  evidence?: string;
}

/**
 * Source-neutral unit that can be independently discovered, read, checkpointed,
 * fingerprinted, normalized, and traced back to its origin.
 */
export interface ExperienceUnit {
  source: SourceIdentity;
  sourceVersion?: SourceVersion;
  experienceId: ExperienceId;
  startedAt: ExperienceTimestamp;
  endedAt: ExperienceTimestamp;
  metadata: Record<string, unknown>;
}

export interface ExperienceActor {
  actorId: string;
  kind: "user" | "assistant" | "agent" | "system" | "tool" | "service" | "unknown";
  displayName?: string;
  metadata?: Record<string, unknown>;
}

export interface ExperienceEvent {
  eventId: string;
  eventType: string;
  actorId?: string;
  occurredAt: ExperienceTimestamp;
  content?: unknown;
  metadata?: Record<string, unknown>;
}

export interface ExperienceContent {
  mediaType: string;
  text?: string;
  payload?: unknown;
}

export interface ExperienceProvenance {
  source: SourceIdentity;
  sourceVersion?: SourceVersion;
  sourceFingerprint: SourceFingerprint;
  adapterName: string;
  adapterVersion: string;
  discoveredAt: string;
  readAt: string;
  normalizedAt: string;
  /** Opaque source-local locator. DLMF Core must never parse this value. */
  sourceLocator?: string;
}

/** Canonical source-neutral contract handed from Adapter Layer into DLMF. */
export interface NormalizedExperience {
  sourceSystem: string;
  sourceType: string;
  sourceId: string;
  sourceVersion?: SourceVersion;
  experienceId: ExperienceId;
  startedAt: ExperienceTimestamp;
  endedAt: ExperienceTimestamp;
  actors: ExperienceActor[];
  events: ExperienceEvent[];
  content: ExperienceContent[];
  metadata: Record<string, unknown>;
  provenance: ExperienceProvenance;
}

export type CapabilitySupport = "full" | "partial" | "none" | "unknown";

export interface SourceAdapterCapabilityManifest {
  historicalImport: CapabilitySupport;
  incrementalSync: CapabilitySupport;
  stableSourceId: CapabilitySupport;
  timestamps: CapabilitySupport;
  toolEvents: CapabilitySupport;
  attachments: CapabilitySupport;
  deletionDetection: CapabilitySupport;
}

export interface SourceAdapterInspection {
  adapterName: string;
  adapterVersion: string;
  sourceSystem: string;
  sourceType: string;
  capabilities: SourceAdapterCapabilityManifest;
  metadata: Record<string, unknown>;
}

export interface DiscoverRequest {
  cursor?: string;
  limit: number;
  checkpoint?: SourceCheckpoint;
}

export interface DiscoverPage {
  units: ExperienceUnit[];
  nextCursor?: string;
}

/** Adapter-owned raw representation. DLMF Core treats payload as opaque. */
export interface SourceReadResult<TSourcePayload = unknown> {
  unit: ExperienceUnit;
  payload: TSourcePayload;
  readAt: string;
}

export interface SourceCheckpoint {
  adapterName: string;
  adapterVersion: string;
  sourceSystem: string;
  sourceType: string;
  cursor?: string;
  lastExperienceId?: ExperienceId;
  lastSourceFingerprint?: SourceFingerprint;
  updatedAt: string;
}
