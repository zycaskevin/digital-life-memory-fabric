import assert from "node:assert/strict";
import test from "node:test";
import type { DistillationReceipt, TranscriptDistillationInput } from "../src/distillation/types.js";
import {
  NormalizedExperienceDistillationBridge,
  normalizedExperienceToTranscriptInput,
} from "../src/source-adapters/normalized-experience-distillation.js";
import { experienceIdFor } from "../src/source-adapters/identity.js";
import type { NormalizedExperience } from "../src/source-adapters/contracts.js";

const source = {
  sourceSystem: "reference-source",
  sourceType: "conversation_thread",
  sourceId: "source-local-42",
};

const experience: NormalizedExperience = {
  ...source,
  sourceVersion: { value: "rev-7", scheme: "native" },
  experienceId: experienceIdFor(source),
  startedAt: {
    value: "2026-09-12T12:00:00.000Z",
    certainty: "exact",
    evidence: "source.started_at",
  },
  endedAt: { certainty: "unknown" },
  actors: [
    { actorId: "person", kind: "user" },
    { actorId: "agent", kind: "assistant" },
    { actorId: "service", kind: "service" },
  ],
  events: [
    {
      eventId: "evt-source-1",
      eventType: "message",
      actorId: "person",
      occurredAt: { value: "2026-09-12T12:00:01.000Z", certainty: "exact" },
      content: "I prefer concise answers.",
    },
    {
      eventId: "evt-source-2",
      eventType: "message",
      actorId: "agent",
      occurredAt: { value: "2026-09-12T12:00:02.000Z", certainty: "inferred" },
      content: "Acknowledged.",
    },
    {
      eventId: "evt-source-3",
      eventType: "service_event",
      actorId: "service",
      occurredAt: { certainty: "unknown" },
      content: "Delivery receipt recorded.",
    },
  ],
  content: [{ mediaType: "text/plain", text: "duplicate fallback must not be appended" }],
  metadata: { sourceNativeField: "must remain opaque to DLMF Core" },
  provenance: {
    source,
    sourceVersion: { value: "rev-7", scheme: "native" },
    sourceFingerprint: { algorithm: "sha256", value: "a".repeat(64) },
    adapterName: "ReferenceSourceAdapter",
    adapterVersion: "1.0.0",
    discoveredAt: "2026-09-12T12:01:00.000Z",
    readAt: "2026-09-12T12:01:01.000Z",
    normalizedAt: "2026-09-12T12:01:02.000Z",
    sourceLocator: "opaque:reference:42",
  },
};

const context = {
  scope: {
    tenantId: "arthur",
    lifeDid: "did:life:nancy",
    memoryNamespace: "nancy.primary",
  },
  origin: {
    lifeDid: "did:life:nancy",
    agentId: "nancy",
    runtimeId: "nancy-gb10",
  },
  policies: {
    distillationPolicyVersion: "distill-v1",
    canonicalizationPolicyVersion: "canonical-v1",
    admissionPolicyVersion: "admission-v1",
    retentionPolicyVersion: "retention-v1",
  },
};

test("normalized experience bridges source-neutrally into role-aware transcript distillation", () => {
  const input = normalizedExperienceToTranscriptInput(experience, context);
  assert.equal(input.sourceType, "normalized_experience");
  assert.equal(input.sourceId, experience.experienceId);
  assert.equal(input.contentType, "text/plain; profile=normalized-experience");
  assert.match(input.content, /User \[2026-09-12T12:00:01.000Z\]:\nI prefer concise answers\./);
  assert.match(input.content, /Assistant:\nAcknowledged\./);
  assert.match(input.content, /Service:\nDelivery receipt recorded\./);
  assert.doesNotMatch(input.content, /duplicate fallback/);
  assert.deepEqual(input.sourceSegments, [
    {
      segmentId: "evt-source-1",
      actor: "user",
      content: "I prefer concise answers.",
      observedAt: "2026-09-12T12:00:01.000Z",
    },
    {
      segmentId: "evt-source-2",
      actor: "assistant",
      content: "Acknowledged.",
    },
    {
      segmentId: "evt-source-3",
      actor: "unknown",
      content: "Delivery receipt recorded.",
    },
  ]);
  assert.equal(input.createdAt, "2026-09-12T12:00:00.000Z");
  assert.equal(input.observedAt, "2026-09-12T12:00:00.000Z");
  const metadata = input.metadata?.normalizedExperience as Record<string, unknown>;
  assert.equal(metadata.sourceSystem, "reference-source");
  assert.equal(metadata.sourceType, "conversation_thread");
  assert.equal(metadata.sourceId, "source-local-42");
  assert.deepEqual(metadata.provenance, experience.provenance);
});

test("normalized experience preserves content-free structured tool-call evidence", () => {
  const toolOnly: NormalizedExperience = {
    ...structuredClone(experience),
    events: [
      ...structuredClone(experience.events),
      {
        eventId: "evt-tool-only",
        eventType: "tool_or_message",
        actorId: "agent",
        occurredAt: { certainty: "unknown" },
        metadata: {
          toolName: "inspect",
          toolCallId: "call-42",
          toolCalls: '[{"name":"inspect","arguments":{"scope":"bounded"}}]',
        },
      },
    ],
  };
  const input = normalizedExperienceToTranscriptInput(toolOnly, context);
  const segment = input.sourceSegments?.at(-1);
  assert.equal(segment?.segmentId, "evt-tool-only");
  assert.equal(segment?.actor, "assistant");
  assert.match(segment?.content ?? "", /Tool name: inspect/);
  assert.match(segment?.content ?? "", /Tool call ID: call-42/);
  assert.match(segment?.content ?? "", /"scope":"bounded"/);
  assert.match(input.content, /Assistant:\nTool name: inspect/);
});

test("normalized experience fallback content remains source-neutral and conservative", () => {
  const fallback: NormalizedExperience = {
    ...structuredClone(experience),
    events: [],
    actors: [],
    content: [{ mediaType: "text/plain", text: "Standalone document text." }],
  };
  const input = normalizedExperienceToTranscriptInput(fallback, context);
  assert.equal(input.content, "Unknown:\nStandalone document text.");
  assert.deepEqual(input.sourceSegments, [{
    segmentId: "normalized-content:0",
    actor: "unknown",
    content: "Standalone document text.",
  }]);
});

test("normalized experience without textual evidence fails instead of inventing memory input", () => {
  const empty: NormalizedExperience = {
    ...structuredClone(experience),
    events: [{
      eventId: "binary-event",
      eventType: "attachment",
      occurredAt: { certainty: "unknown" },
      content: { binaryRef: "opaque" },
    }],
    content: [{ mediaType: "application/octet-stream", payload: { ref: "opaque" } }],
  };
  assert.throws(
    () => normalizedExperienceToTranscriptInput(empty, context),
    /no textual evidence eligible for distillation/,
  );
});

test("bridge delegates only the normalized transcript input to DLMF distillation", async () => {
  let captured: TranscriptDistillationInput | undefined;
  const fakeReceipt = { receiptId: `dist_${"b".repeat(64)}` } as DistillationReceipt;
  const bridge = new NormalizedExperienceDistillationBridge({
    ...context,
    distillation: {
      async run(input) {
        captured = input;
        return fakeReceipt;
      },
    },
  });
  const receipt = await bridge.ingest(experience);
  assert.equal(receipt, fakeReceipt);
  assert.equal(captured?.sourceId, experience.experienceId);
  assert.equal(captured?.sourceType, "normalized_experience");
});
