import type { MemoryAuthor, MemoryScope } from "../domain/types.js";
import type { TranscriptDistillationService } from "../distillation/transcript-distillation-service.js";
import type {
  DistillationReceipt,
  DistillationSourceActor,
  DistillationSourceSegment,
  TranscriptDistillationInput,
} from "../distillation/types.js";
import type {
  ExperienceActor,
  ExperienceEvent,
  NormalizedExperience,
} from "./contracts.js";
import { assertNormalizedExperience } from "./validation.js";

export const NORMALIZED_EXPERIENCE_SOURCE_TYPE = "normalized_experience";
export const NORMALIZED_EXPERIENCE_CONTENT_TYPE = "text/plain; profile=normalized-experience";

export interface NormalizedExperienceDistillationPolicies {
  distillationPolicyVersion: string;
  canonicalizationPolicyVersion: string;
  admissionPolicyVersion: string;
  retentionPolicyVersion: string;
}

export interface NormalizedExperienceDistillationContext {
  scope: MemoryScope;
  origin: MemoryAuthor;
  policies: NormalizedExperienceDistillationPolicies;
}

export interface NormalizedExperienceDistillationBridgeOptions
  extends NormalizedExperienceDistillationContext {
  distillation: Pick<TranscriptDistillationService, "run">;
}

function exactTimestamp(value: { value?: string; certainty: string }): string | undefined {
  return value.certainty === "exact" && value.value !== undefined ? value.value : undefined;
}

function actorFor(
  actorId: string | undefined,
  actors: ReadonlyMap<string, ExperienceActor>,
): { sourceKind: ExperienceActor["kind"]; distillationActor: DistillationSourceActor; label: string } {
  const sourceKind = actorId === undefined ? "unknown" : (actors.get(actorId)?.kind ?? "unknown");
  switch (sourceKind) {
    case "user": return { sourceKind, distillationActor: "user", label: "User" };
    case "assistant": return { sourceKind, distillationActor: "assistant", label: "Assistant" };
    case "system": return { sourceKind, distillationActor: "system", label: "System" };
    case "tool": return { sourceKind, distillationActor: "tool", label: "Tool" };
    case "agent": return { sourceKind, distillationActor: "unknown", label: "Agent" };
    case "service": return { sourceKind, distillationActor: "unknown", label: "Service" };
    default: return { sourceKind: "unknown", distillationActor: "unknown", label: "Unknown" };
  }
}

function textEventSegments(experience: NormalizedExperience): Array<{
  segment: DistillationSourceSegment;
  rendered: string;
}> {
  const actors = new Map(experience.actors.map((actor) => [actor.actorId, actor]));
  const results: Array<{ segment: DistillationSourceSegment; rendered: string }> = [];
  for (const event of experience.events) {
    if (typeof event.content !== "string" || event.content.trim().length === 0) continue;
    const content = event.content.trim();
    const actor = actorFor(event.actorId, actors);
    const observedAt = exactTimestamp(event.occurredAt);
    results.push({
      segment: {
        segmentId: event.eventId,
        actor: actor.distillationActor,
        content,
        ...(observedAt === undefined ? {} : { observedAt }),
      },
      rendered: `${actor.label}${observedAt === undefined ? "" : ` [${observedAt}]`}:\n${content}`,
    });
  }
  return results;
}

function fallbackContentSegments(experience: NormalizedExperience): Array<{
  segment: DistillationSourceSegment;
  rendered: string;
}> {
  const results: Array<{ segment: DistillationSourceSegment; rendered: string }> = [];
  for (const [index, item] of experience.content.entries()) {
    if (typeof item.text !== "string" || item.text.trim().length === 0) continue;
    const content = item.text.trim();
    results.push({
      segment: {
        segmentId: `normalized-content:${index}`,
        actor: "unknown",
        content,
      },
      rendered: `Unknown:\n${content}`,
    });
  }
  return results;
}

function requireContext(context: NormalizedExperienceDistillationContext): void {
  const required = [
    [context.scope.tenantId, "scope.tenantId"],
    [context.scope.lifeDid, "scope.lifeDid"],
    [context.scope.memoryNamespace, "scope.memoryNamespace"],
    [context.origin.lifeDid, "origin.lifeDid"],
    [context.policies.distillationPolicyVersion, "distillationPolicyVersion"],
    [context.policies.canonicalizationPolicyVersion, "canonicalizationPolicyVersion"],
    [context.policies.admissionPolicyVersion, "admissionPolicyVersion"],
    [context.policies.retentionPolicyVersion, "retentionPolicyVersion"],
  ] as const;
  for (const [value, field] of required) {
    if (value.trim().length === 0) throw new Error(`${field} must not be empty`);
  }
  if (context.origin.lifeDid !== context.scope.lifeDid) {
    throw new Error("origin.lifeDid must match scope.lifeDid");
  }
}

/**
 * Convert a source-neutral NormalizedExperience into the existing DLMF Memory
 * Intelligence ingress. Source-specific schemas stop before this function.
 */
export function normalizedExperienceToTranscriptInput(
  experience: NormalizedExperience,
  context: NormalizedExperienceDistillationContext,
): TranscriptDistillationInput {
  assertNormalizedExperience(experience);
  requireContext(context);

  let projected = textEventSegments(experience);
  if (projected.length === 0) projected = fallbackContentSegments(experience);
  if (projected.length === 0) {
    throw new Error("NormalizedExperience contains no textual evidence eligible for distillation");
  }

  const createdAt = exactTimestamp(experience.startedAt);
  const observedAt = exactTimestamp(experience.startedAt);
  return {
    scope: structuredClone(context.scope),
    origin: structuredClone(context.origin),
    sourceType: NORMALIZED_EXPERIENCE_SOURCE_TYPE,
    sourceId: experience.experienceId,
    content: projected.map((item) => item.rendered).join("\n\n"),
    contentType: NORMALIZED_EXPERIENCE_CONTENT_TYPE,
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(observedAt === undefined ? {} : { observedAt }),
    metadata: {
      normalizedExperience: {
        sourceSystem: experience.sourceSystem,
        sourceType: experience.sourceType,
        sourceId: experience.sourceId,
        experienceId: experience.experienceId,
        sourceVersion: experience.sourceVersion ?? null,
        startedAt: experience.startedAt,
        endedAt: experience.endedAt,
        actorCount: experience.actors.length,
        eventCount: experience.events.length,
        contentCount: experience.content.length,
        provenance: experience.provenance,
      },
    },
    sourceSegments: projected.map((item) => item.segment),
    ...structuredClone(context.policies),
  };
}

export class NormalizedExperienceDistillationBridge {
  readonly #distillation: Pick<TranscriptDistillationService, "run">;
  readonly #context: NormalizedExperienceDistillationContext;

  constructor(options: NormalizedExperienceDistillationBridgeOptions) {
    this.#distillation = options.distillation;
    this.#context = {
      scope: structuredClone(options.scope),
      origin: structuredClone(options.origin),
      policies: structuredClone(options.policies),
    };
    requireContext(this.#context);
  }

  async ingest(experience: NormalizedExperience): Promise<DistillationReceipt> {
    return this.#distillation.run(
      normalizedExperienceToTranscriptInput(experience, this.#context),
    );
  }
}
