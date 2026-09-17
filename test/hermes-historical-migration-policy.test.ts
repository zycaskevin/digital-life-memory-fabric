import assert from "node:assert/strict";
import test from "node:test";
import type { NormalizedExperience } from "../src/source-adapters/contracts.js";
import { HermesHistoricalMigrationEligibilityPolicy } from "../src/source-adapters/hermes-historical-migration-policy.js";
import { experienceIdFor, sha256SourceFingerprint } from "../src/source-adapters/identity.js";

function experience(options: {
  hidden?: boolean;
  messageCount?: number;
  text?: string;
  sourceSystem?: string;
  sourceType?: string;
} = {}): NormalizedExperience {
  const source = {
    sourceSystem: options.sourceSystem ?? "hermes",
    sourceType: options.sourceType ?? "conversation_session",
    sourceId: "session-1",
  };
  return {
    ...source,
    experienceId: experienceIdFor(source),
    startedAt: { certainty: "unknown" },
    endedAt: { certainty: "unknown" },
    actors: options.text === undefined ? [] : [{ actorId: "hermes:user", kind: "user" }],
    events: options.text === undefined ? [] : [{
      eventId: "hermes-message:1",
      eventType: "message",
      actorId: "hermes:user",
      occurredAt: { certainty: "unknown" },
      content: options.text,
    }],
    content: options.text === undefined ? [] : [{ mediaType: "text/plain", text: options.text }],
    metadata: {
      hidden: options.hidden ?? false,
      messageCount: options.messageCount ?? (options.text === undefined ? 0 : 1),
    },
    provenance: {
      source,
      sourceFingerprint: sha256SourceFingerprint("fixture"),
      adapterName: "HermesSourceAdapter",
      adapterVersion: "0.1.0",
      discoveredAt: "2026-09-12T12:00:00.000Z",
      readAt: "2026-09-12T12:00:01.000Z",
      normalizedAt: "2026-09-12T12:00:02.000Z",
    },
  };
}

const policy = new HermesHistoricalMigrationEligibilityPolicy();

test("Hermes migration policy keeps hidden sessions out of Memory Intelligence", () => {
  assert.deepEqual(policy.assess(experience({ hidden: true, text: "private historical text" })), {
    eligible: false,
    reasonCode: "hermes_hidden_session",
  });
});

test("Hermes migration policy skips empty sessions without treating them as deletion", () => {
  assert.deepEqual(policy.assess(experience({ messageCount: 0 })), {
    eligible: false,
    reasonCode: "hermes_empty_session",
  });
});

test("Hermes migration policy accepts visible sessions with textual evidence", () => {
  assert.deepEqual(policy.assess(experience({ text: "I prefer concise answers." })), {
    eligible: true,
    reasonCode: "hermes_textual_evidence",
  });
});

test("Hermes migration policy rejects foreign normalized sources", () => {
  assert.throws(
    () => policy.assess(experience({ sourceSystem: "openclaw" })),
    /foreign NormalizedExperience/,
  );
});
