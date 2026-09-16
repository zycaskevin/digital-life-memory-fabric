import assert from "node:assert/strict";
import test from "node:test";
import type { MemoryRevision } from "../src/domain/types.js";
import { ObsidianCanonicalMemoryProjection } from "../src/obsidian/canonical-memory-projection.js";

function revision(): MemoryRevision {
  return {
    memoryId: "mem_obsidian_test",
    revision: 3,
    scope: {
      tenantId: "tenant-arthur",
      lifeDid: "did:arthurverse:nancy",
      memoryNamespace: "private/default",
    },
    memoryClass: "preference",
    memoryKind: "interaction_preference",
    memoryType: "preference",
    speakerProvenance: "user",
    semanticKey: "preference:debugging:step-size",
    status: "active",
    canonicalContent: {
      text: "Arthur prefers debugging in one or two steps at a time.",
      payload: { internalOnly: "not projected in MVP" },
    },
    contentHash: "content-hash",
    author: {
      lifeDid: "did:arthurverse:nancy",
    },
    provenance: {
      sourceType: "hermes_conversation",
      sourceId: "session-123",
      candidateId: "cand_obsidian_test",
      candidateFingerprint: "candidate-fingerprint",
      producer: {
        kind: "import",
        id: "HermesSourceAdapter",
        adapterVersion: "0.1.0",
      },
      sourceExperienceRefs: [
        {
          sourceType: "hermes_conversation",
          sourceId: "session-123",
        },
      ],
    },
    evidenceRefs: [
      {
        sourceType: "hermes_conversation",
        sourceRef: "session-123#message-9",
      },
    ],
    epistemicStatus: "user_asserted",
    producer: {
      kind: "import",
      id: "HermesSourceAdapter",
      adapterVersion: "0.1.0",
    },
    sourceExperienceRefs: [
      {
        sourceType: "hermes_conversation",
        sourceId: "session-123",
      },
    ],
    semanticFingerprint: "semantic-fingerprint",
    committedAt: "2026-09-16T09:00:00.000Z",
    commitSeq: 42,
  };
}

test("Obsidian projection creates one memory note plus deterministic graph nodes", () => {
  const bundle = new ObsidianCanonicalMemoryProjection().project(revision());

  assert.equal(bundle.schemaVersion, "1");
  assert.equal(bundle.memoryId, "mem_obsidian_test");
  assert.equal(bundle.canonicalRevision, 3);
  assert.equal(bundle.commitSeq, 42);
  assert.equal(bundle.notes.length, 5);

  const memory = bundle.notes[0];
  assert.ok(memory);
  assert.equal(memory.path, "90 DLMF/Memories/mem_obsidian_test.md");
  assert.equal(memory.nodeKind, "memory");
  assert.equal(memory.sourceMemoryId, "mem_obsidian_test");
  assert.match(memory.content, /dlmf_managed: true/);
  assert.match(memory.content, /Arthur prefers debugging in one or two steps at a time\./);
  assert.match(memory.content, /\[\[90 DLMF\/Memory Classes\/preference\|Memory class: preference\]\]/);
  assert.match(memory.content, /\[\[90 DLMF\/Memory Types\/preference\|Memory type: preference\]\]/);
  assert.match(memory.content, /\[\[90 DLMF\/Namespaces\/private-default\|Namespace: private\/default\]\]/);
  assert.match(memory.content, /\[\[90 DLMF\/Source Types\/hermes_conversation\|Source type: hermes_conversation\]\]/);
});

test("Obsidian projection does not leak arbitrary canonical payload into Markdown", () => {
  const bundle = new ObsidianCanonicalMemoryProjection().project(revision());
  const memory = bundle.notes[0];
  assert.ok(memory);

  assert.doesNotMatch(memory.content, /internalOnly/);
  assert.doesNotMatch(memory.content, /not projected in MVP/);
});

test("Obsidian projection rejects managed-root traversal", () => {
  assert.throws(
    () => new ObsidianCanonicalMemoryProjection({ managedRoot: "../Vault" }),
    /relative vault path without traversal/,
  );
});

test("Obsidian projection supports a user-selected managed subdirectory", () => {
  const bundle = new ObsidianCanonicalMemoryProjection({ managedRoot: "DLMF/Generated" }).project(revision());
  const memory = bundle.notes[0];
  assert.ok(memory);

  assert.equal(memory.path, "DLMF/Generated/Memories/mem_obsidian_test.md");
  assert.match(memory.content, /\[\[DLMF\/Generated\/Memory Types\/preference\|Memory type: preference\]\]/);
});
