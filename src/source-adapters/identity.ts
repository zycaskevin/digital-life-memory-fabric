import { createHash } from "node:crypto";
import type { ExperienceId, SourceFingerprint, SourceIdentity } from "./contracts.js";

function requireNonEmpty(label: string, value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must not be empty`);
  return normalized;
}

/** Deterministic DLMF-owned ID; source version is intentionally excluded. */
export function experienceIdFor(source: SourceIdentity): ExperienceId {
  const canonical = [
    requireNonEmpty("sourceSystem", source.sourceSystem),
    requireNonEmpty("sourceType", source.sourceType),
    requireNonEmpty("sourceId", source.sourceId),
  ].join("\u001f");
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `exp_${digest}`;
}

export function sha256SourceFingerprint(content: string | Uint8Array): SourceFingerprint {
  const digest = createHash("sha256").update(content).digest("hex");
  return { algorithm: "sha256", value: digest };
}
