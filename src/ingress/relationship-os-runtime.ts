import type { Pool } from "pg";
import { FilesystemRawExperienceArchiveProvider } from "../archive/filesystem-raw-experience-archive.js";
import { ConservativeMemoryCurationProvider } from "../curation/conservative-memory-curation-provider.js";
import { DeterministicCanonicalAdmissionPolicy } from "../curation/deterministic-canonical-admission-policy.js";
import { PostgresMemoryCurationRecordStore } from "../curation/postgres-memory-curation-record-store.js";
import { EvidenceBoundMemoryGovernance } from "../distillation/governance.js";
import {
  HindsightMemoryAdapter,
  type HindsightClientPort,
} from "../distillation/hindsight-memory-adapter.js";
import { PostgresDistillationReceiptStore } from "../distillation/postgres-distillation-receipt-store.js";
import { TranscriptDistillationService } from "../distillation/transcript-distillation-service.js";
import type { DistillationReceipt, TranscriptDistillationInput } from "../distillation/types.js";
import {
  RelationshipOsDlmfIngress,
  type RelationshipOsIngressPolicies,
} from "./relationship-os-http.js";
import {
  DeterministicHindsightPlaneResolver,
  HindsightCanonicalProjectionPort,
} from "../retrieval/hindsight-canonical-projection.js";
import { VerifiedRetrievalService } from "../retrieval/verified-retrieval-service.js";
import { PostgresCanonicalMemoryStore } from "../store/postgres-canonical-memory-store.js";
import { CanonicalVerifier } from "../verification/canonical-verifier.js";

export interface RelationshipOsDlmfRuntimeOptions {
  pool: Pool;
  archiveRoot: string;
  hindsightClient: HindsightClientPort;
  hindsightAdapterVersion: string;
  hindsightProviderVersion?: string;
  hindsightBankPrefix: string;
  bearerToken: string;
  allowedTenantId: string;
  allowedLifeDid: string;
  memoryNamespacePrefix: string;
  agentId: string;
  runtimeId?: string;
  policies: RelationshipOsIngressPolicies;
  curationProviderVersion?: string;
}

export interface RelationshipOsDlmfRuntime {
  ingress: RelationshipOsDlmfIngress;
  canonicalStore: PostgresCanonicalMemoryStore;
  close(): Promise<void>;
}

/**
 * Production composition for the Relationship OS ingress.
 *
 * The caller supplies deployment resources and credentials. This factory only
 * composes existing DLMF authorities: PostgreSQL canonical state, raw archive,
 * Hindsight distillation, MD-010 curation/admission, provider projection, and
 * verified canonical retrieval.
 */
export function createRelationshipOsDlmfRuntime(
  options: RelationshipOsDlmfRuntimeOptions,
): RelationshipOsDlmfRuntime {
  const store = new PostgresCanonicalMemoryStore(options.pool);
  const receiptStore = new PostgresDistillationReceiptStore(options.pool);
  const curationStore = new PostgresMemoryCurationRecordStore(options.pool);
  const archive = new FilesystemRawExperienceArchiveProvider(options.archiveRoot);
  const governance = new EvidenceBoundMemoryGovernance(
    options.policies.canonicalizationPolicyVersion,
  );
  const admissionPolicy = new DeterministicCanonicalAdmissionPolicy(
    options.policies.admissionPolicyVersion,
  );
  const curationProvider = new ConservativeMemoryCurationProvider(
    options.curationProviderVersion ?? "md010-conservative-v2",
  );
  const banks = new DeterministicHindsightPlaneResolver(options.hindsightBankPrefix);
  const provider = new HindsightMemoryAdapter({
    client: options.hindsightClient,
    banks,
    adapterVersion: options.hindsightAdapterVersion,
    ...(options.hindsightProviderVersion === undefined
      ? {}
      : { providerVersion: options.hindsightProviderVersion }),
    recallBudget: "mid",
    reflectBudget: "mid",
  });
  const distillation = new TranscriptDistillationService({
    canonicalStore: store,
    receiptStore,
    archive,
    provider,
    curationProvider,
    curationStore,
    admissionPolicy,
    governance,
  });
  const projection = new HindsightCanonicalProjectionPort({
    client: options.hindsightClient,
    banks,
    providerId: "hindsight",
    recallBudget: "mid",
  });
  const projectingDistillation = new RetrievalProjectionDistillationPort(
    distillation,
    store,
    projection,
  );
  const retrieval = new VerifiedRetrievalService(
    new CanonicalVerifier(store),
    projection,
  );
  const ingress = new RelationshipOsDlmfIngress({
    bearerToken: options.bearerToken,
    allowedTenantId: options.allowedTenantId,
    allowedLifeDid: options.allowedLifeDid,
    memoryNamespacePrefix: options.memoryNamespacePrefix,
    agentId: options.agentId,
    ...(options.runtimeId === undefined ? {} : { runtimeId: options.runtimeId }),
    distillation: projectingDistillation,
    retrieval,
    policies: options.policies,
  });

  return {
    ingress,
    canonicalStore: store,
    close: () => store.close(),
  };
}

class RetrievalProjectionDistillationPort {
  constructor(
    private readonly distillation: TranscriptDistillationService,
    private readonly store: PostgresCanonicalMemoryStore,
    private readonly projection: HindsightCanonicalProjectionPort,
  ) {}

  async run(input: TranscriptDistillationInput): Promise<DistillationReceipt> {
    const receipt = await this.distillation.run(input);
    if (receipt.status !== "complete" && receipt.status !== "awaiting_review") {
      return receipt;
    }

    // This projection is a bounded retrieval sidecar only. It deliberately does
    // not settle DLMF memory_outbox/provider_materializations: that provider
    // materialization authority remains on the OmniHarness boundary. A retry of
    // the same completed DLMF receipt may repair this disposable search view.
    for (const memoryId of receipt.canonicalMemoryIds) {
      const head = await this.store.getHead(memoryId);
      if (head === undefined) throw new Error("canonical_projection_head_missing");
      if (
        head.scope.tenantId !== input.scope.tenantId
        || head.scope.lifeDid !== input.scope.lifeDid
        || head.scope.memoryNamespace !== input.scope.memoryNamespace
      ) {
        throw new Error("canonical_projection_scope_mismatch");
      }
      const revision = await this.store.getRevision(memoryId, head.currentRevision);
      if (revision === undefined) throw new Error("canonical_projection_revision_missing");
      await this.projection.project(revision);
    }
    return receipt;
  }
}
