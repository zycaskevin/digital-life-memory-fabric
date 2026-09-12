import type { NormalizedExperience } from "./contracts.js";
import { experienceIdFor } from "./identity.js";

export function assertNormalizedExperience(value: NormalizedExperience): void {
  if (value.sourceSystem.trim() === "") throw new Error("sourceSystem must not be empty");
  if (value.sourceType.trim() === "") throw new Error("sourceType must not be empty");
  if (value.sourceId.trim() === "") throw new Error("sourceId must not be empty");

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

  for (const timestamp of [value.startedAt, value.endedAt]) {
    if (timestamp.certainty === "exact" && timestamp.value === undefined) {
      throw new Error("exact timestamp requires a value");
    }
    if (timestamp.certainty === "unknown" && timestamp.value !== undefined) {
      throw new Error("unknown timestamp must not invent a value");
    }
  }
}
