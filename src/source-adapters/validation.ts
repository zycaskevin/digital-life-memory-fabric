import type { NormalizedExperience } from "./contracts.js";
import { experienceIdFor } from "./identity.js";

export function assertNormalizedExperience(value: NormalizedExperience): void {
  for (const [field, raw] of [
    ["sourceSystem", value.sourceSystem],
    ["sourceType", value.sourceType],
    ["sourceId", value.sourceId],
  ] as const) {
    if (raw.trim() === "") throw new Error(`${field} must not be empty`);
    if (raw !== raw.trim()) {
      throw new Error(`${field} must not contain surrounding whitespace`);
    }
  }

  const expectedId = experienceIdFor({
    sourceSystem: value.sourceSystem,
    sourceType: value.sourceType,
    sourceId: value.sourceId,
  });
  if (value.experienceId !== expectedId) {
    throw new Error("experienceId must be derived from stable source identity");
  }

  if (
    value.provenance.source.sourceSystem !== value.sourceSystem ||
    value.provenance.source.sourceType !== value.sourceType ||
    value.provenance.source.sourceId !== value.sourceId
  ) {
    throw new Error("provenance source identity must match normalized source identity");
  }

  const sourceFingerprint = value.provenance.sourceFingerprint as unknown;
  if (
    sourceFingerprint === null
    || typeof sourceFingerprint !== "object"
    || Array.isArray(sourceFingerprint)
    || (sourceFingerprint as { algorithm?: unknown }).algorithm !== "sha256"
    || typeof (sourceFingerprint as { value?: unknown }).value !== "string"
    || !/^[0-9a-f]{64}$/.test((sourceFingerprint as { value: string }).value)
  ) {
    throw new Error("provenance source fingerprint must be a lowercase sha256 digest");
  }

  for (const timestamp of [value.startedAt, value.endedAt]) {
    if (timestamp.certainty === "exact" && timestamp.value === undefined) {
      throw new Error("exact timestamp requires a value");
    }
    if (timestamp.certainty === "unknown" && timestamp.value !== undefined) {
      throw new Error("unknown timestamp must not invent a value");
    }
  }
}
