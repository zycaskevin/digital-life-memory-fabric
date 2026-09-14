import type {
  DiscoverPage,
  DiscoverRequest,
  NormalizedExperience,
  SourceAdapterInspection,
  SourceFingerprint,
  SourceReadResult,
  ExperienceUnit,
} from "./contracts.js";

/**
 * Boundary implemented by every external Memory Source Adapter.
 * Source-specific schemas MUST stop here and MUST NOT leak into DLMF Core.
 */
export interface MemorySourceAdapter<TSourcePayload = unknown> {
  readonly name: string;
  readonly version: string;

  inspect(): Promise<SourceAdapterInspection>;
  discover(request: DiscoverRequest): Promise<DiscoverPage>;
  read(unit: ExperienceUnit): Promise<SourceReadResult<TSourcePayload>>;
  normalize(result: SourceReadResult<TSourcePayload>): Promise<NormalizedExperience>;
  fingerprint(unit: ExperienceUnit): Promise<SourceFingerprint>;
}
