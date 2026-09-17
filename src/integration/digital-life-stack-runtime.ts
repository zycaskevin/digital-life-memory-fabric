import type { Pool } from "pg";
import { FilesystemRawExperienceArchiveProvider } from "../archive/filesystem-raw-experience-archive.js";
import { ConservativeMemoryCurationProvider } from "../curation/conservative-memory-curation-provider.js";
import { DeterministicCanonicalAdmissionPolicy } from "../curation/deterministic-canonical-admission-policy.js";
import { PostgresMemoryCurationRecordStore } from "../curation/postgres-memory-curation-record-store.js";
import { EvidenceBoundMemoryGovernance } from "../distillation/governance.js";
import type { MemoryDistillationProvider } from "../distillation/memory-distillation-provider.js";
import type { ProviderExtractionArtifactStore } from "../distillation/provider-extraction-artifact-store.js";
import { PostgresDistillationReceiptStore } from "../distillation/postgres-distillation-receipt-store.js";
import { TranscriptDistillationService } from "../distillation/transcript-distillation-service.js";
import type { DistillationReceipt, TranscriptDistillationInput } from "../distillation/types.js";
import type { MemoryRevision, MemoryScope } from "../domain/types.js";
import type { MemoryRetrievalPort } from "../retrieval/types.js";
import { NormalizedExperienceDistillationBridge } from "../source-adapters/normalized-experience-distillation.js";
import type { NormalizedExperienceIngestor } from "../source-adapters/source-migration.js";
import { VerifiedRetrievalService } from "../retrieval/verified-retrieval-service.js";
import { PostgresSemanticReviewStore } from "../review/postgres-semantic-review-store.js";
import { SemanticReviewQueueService } from "../review/semantic-review-service.js";
import type { SemanticReviewRemediationPolicy } from "../review/semantic-review-remediation.js";
import { PostgresCanonicalMemoryStore } from "../store/postgres-canonical-memory-store.js";
import { CanonicalVerifier } from "../verification/canonical-verifier.js";
import {
  DigitalLifeStackDlmfIngress,
  type DigitalLifeStackDlmfPolicies,
  type DigitalLifeStackDlmfReadiness,
} from "./digital-life-stack-http.js";

export interface DigitalLifeStackDlmfRuntimeOptions {
  pool: Pool;
  archiveRoot: string;
  bearerToken: string;
  agentId: string;
  runtimeId?: string;
  allowedScope?: MemoryScope;
  policies: DigitalLifeStackDlmfPolicies;
  distillationProvider: MemoryDistillationProvider;
  providerExtractionArtifactStore?: ProviderExtractionArtifactStore;
  retrievalPort: CanonicalProjectionPort;
  curationProviderVersion?: string;
  semanticReviewRemediation?: SemanticReviewRemediationPolicy;
}

export interface CanonicalProjectionPort extends MemoryRetrievalPort {
  project(revision: Readonly<MemoryRevision>): Promise<void>;
}

export interface DigitalLifeStackDlmfRuntime {
  ingress: DigitalLifeStackDlmfIngress;
  /** DLMF-internal adapter/migration ingress. This is not exposed by the HTTP contract. */
  createNormalizedExperienceIngestor(scope: MemoryScope): NormalizedExperienceIngestor;
  close(): Promise<void>;
}

/**
 * DLMF-owned service composition used by Digital-Life-Stack.
 *
 * The provider objects are injected on the DLMF side and never exposed through
 * the HTTP contract. The returned runtime deliberately omits CanonicalMemoryAuthority,
 * PostgresCanonicalMemoryStore, promotion stores, and provider-selection handles.
 */
export function createDigitalLifeStackDlmfRuntime(
  options: DigitalLifeStackDlmfRuntimeOptions,
): DigitalLifeStackDlmfRuntime {
  const canonicalStore = new PostgresCanonicalMemoryStore(options.pool);
  const curationStore = new PostgresMemoryCurationRecordStore(options.pool);
  const semanticReviewQueue = new SemanticReviewQueueService(
    curationStore,
    new PostgresSemanticReviewStore(options.pool),
  );
  const distillation = new TranscriptDistillationService({
    canonicalStore,
    receiptStore: new PostgresDistillationReceiptStore(options.pool),
    archive: new FilesystemRawExperienceArchiveProvider(options.archiveRoot),
    provider: options.distillationProvider,
    ...(options.providerExtractionArtifactStore === undefined
      ? {}
      : { providerExtractionArtifactStore: options.providerExtractionArtifactStore }),
    curationProvider: new ConservativeMemoryCurationProvider(
      options.curationProviderVersion ?? "dls-conservative-v2-lifetime-governance",
    ),
    curationStore,
    admissionPolicy: new DeterministicCanonicalAdmissionPolicy(
      options.policies.admissionPolicyVersion,
    ),
    governance: new EvidenceBoundMemoryGovernance(
      options.policies.canonicalizationPolicyVersion,
    ),
    semanticReviewQueue,
    ...(options.semanticReviewRemediation === undefined
      ? {}
      : { semanticReviewRemediation: options.semanticReviewRemediation }),
  });
  const projectingDistillation = new CanonicalProjectionDistillationPort(
    distillation,
    canonicalStore,
    options.retrievalPort,
  );
  const retrieval = new VerifiedRetrievalService(
    new CanonicalVerifier(canonicalStore),
    options.retrievalPort,
  );
  const readiness = new PostgresDlmfReadiness(options.pool);
  const trustedRuntimeId = options.runtimeId ?? "digital-life-stack";
  const ingress = new DigitalLifeStackDlmfIngress({
    bearerToken: options.bearerToken,
    agentId: options.agentId,
    runtimeId: trustedRuntimeId,
    ...(options.allowedScope === undefined ? {} : { allowedScope: options.allowedScope }),
    policies: options.policies,
    distillation: projectingDistillation,
    retrieval,
    readiness,
  });
  return {
    ingress,
    createNormalizedExperienceIngestor(scope) {
      return new NormalizedExperienceDistillationBridge({
        distillation: projectingDistillation,
        scope,
        origin: {
          lifeDid: scope.lifeDid,
          agentId: options.agentId,
          runtimeId: trustedRuntimeId,
        },
        policies: options.policies,
      });
    },
    close: () => canonicalStore.close(),
  };
}

class CanonicalProjectionDistillationPort {
  constructor(
    private readonly distillation: TranscriptDistillationService,
    private readonly store: PostgresCanonicalMemoryStore,
    private readonly projection: CanonicalProjectionPort,
  ) {}

  async run(input: TranscriptDistillationInput): Promise<DistillationReceipt> {
    const receipt = await this.distillation.run(input);
    if (receipt.status !== "complete" && receipt.status !== "awaiting_review") return receipt;
    for (const memoryId of receipt.canonicalMemoryIds) {
      const head = await this.store.getHead(memoryId);
      if (head === undefined) throw new Error("canonical_projection_head_missing");
      const revision = await this.store.getRevision(memoryId, head.currentRevision);
      if (revision === undefined) throw new Error("canonical_projection_revision_missing");
      await this.projection.project(revision);
    }
    return receipt;
  }
}

class PostgresDlmfReadiness implements DigitalLifeStackDlmfReadiness {
  constructor(private readonly pool: Pool) {}

  async ready(): Promise<{ ready: boolean; schemaState: string }> {
    const row = (await this.pool.query(`SELECT
      to_regclass('memory_heads') IS NOT NULL AS canonical,
      to_regclass('memory_distillation_receipts') IS NOT NULL AS receipts,
      to_regclass('memory_curation_records') IS NOT NULL AS curation,
      to_regclass('semantic_review_cases') IS NOT NULL AS review_cases,
      to_regclass('semantic_review_events') IS NOT NULL AS review_events,
      to_regclass('insight_promotion_records') IS NOT NULL AS promotions,
      to_regclass('insight_promotion_events') IS NOT NULL AS promotion_events,
      to_regclass('dlfm_schema_migrations') IS NOT NULL AS ledger`)).rows[0];
    if (
      row?.canonical !== true || row.receipts !== true || row.curation !== true
      || row.review_cases !== true || row.review_events !== true
      || row.promotions !== true || row.promotion_events !== true || row.ledger !== true
    ) {
      return { ready: false, schemaState: "stale-or-partial" };
    }
    const migrations = (await this.pool.query(
      "SELECT migration_name FROM dlfm_schema_migrations ORDER BY migration_name",
    )).rows.map((value) => String(value.migration_name));
    const ready = migrations.length === 3
      && migrations[0] === "0006_semantic_review_queue.sql"
      && migrations[1] === "0007_insight_promotion_governance.sql"
      && migrations[2] === "0008_provider_extraction_artifacts.sql";
    return { ready, schemaState: ready ? "current-0008" : "stale-or-future" };
  }
}
