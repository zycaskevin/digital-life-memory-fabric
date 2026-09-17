import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  InMemoryCanonicalMemoryStore,
  ObsidianMemoryProjection,
  type MemoryId,
  type MemoryOperation,
  type MemoryScope,
  type MemoryStatus,
  type MemoryType,
  type SpeakerProvenance,
} from "../src/index.js";

const scope: MemoryScope = {
  tenantId: "tenant_obsidian",
  lifeDid: "did:life:nancy",
  memoryNamespace: "life.core",
};

interface AppendOptions {
  memoryId: MemoryId;
  text: string;
  memoryType: MemoryType;
  memoryClass?: "episode" | "semantic_assertion" | "preference" | "relationship_fact";
  memoryKind: string;
  semanticKey: string;
  speaker?: SpeakerProvenance;
  sourceId: string;
  status?: MemoryStatus;
  operation?: MemoryOperation;
}

async function appendRevision(
  store: InMemoryCanonicalMemoryStore,
  options: AppendOptions,
): Promise<void> {
  await store.transaction(async (tx) => {
    const previous = await tx.getHead(options.memoryId);
    const revision = (previous?.currentRevision ?? 0) + 1;
    const commitSeq = await tx.nextCommitSeq(scope);
    const status = options.status ?? "active";
    const memoryClass = options.memoryClass
      ?? (options.memoryType === "preference" ? "preference" : "semantic_assertion");
    const sourceExperienceRefs = [{
      sourceType: "hermes_session",
      sourceId: options.sourceId,
      archiveRef: `archive://${options.sourceId}`,
      checksum: `checksum-${options.sourceId}`,
    }];
    const committedAt = `2026-09-15T0${Math.min(commitSeq, 9)}:00:00.000Z`;

    await tx.putHead({
      memoryId: options.memoryId,
      scope,
      memoryClass,
      memoryKind: options.memoryKind,
      memoryType: options.memoryType,
      semanticKey: options.semanticKey,
      currentRevision: revision,
      status,
      createdAt: previous?.createdAt ?? committedAt,
      updatedAt: committedAt,
    });
    await tx.appendRevision({
      memoryId: options.memoryId,
      revision,
      scope,
      memoryClass,
      memoryKind: options.memoryKind,
      memoryType: options.memoryType,
      speakerProvenance: options.speaker ?? "user",
      semanticKey: options.semanticKey,
      status,
      canonicalContent: { text: options.text },
      contentHash: `content-hash-${options.memoryId}-${revision}`,
      author: { lifeDid: scope.lifeDid, agentId: "nancy" },
      provenance: {
        sourceType: "hermes_session",
        sourceId: options.sourceId,
        candidateId: `cand_${options.memoryId.slice(4)}_${revision}`,
        candidateFingerprint: `candidate-fingerprint-${options.memoryId}-${revision}`,
        producer: { kind: "user", id: "arthur" },
        sourceExperienceRefs,
      },
      evidenceRefs: [{ sourceType: "hermes_session", sourceRef: options.sourceId }],
      epistemicStatus: "user_asserted",
      producer: { kind: "user", id: "arthur" },
      sourceExperienceRefs,
      semanticFingerprint: `semantic-fingerprint-${options.memoryId}-${revision}`,
      committedAt,
      commitSeq,
    });
    await tx.appendChange({
      eventId: `evt_obsidian_${commitSeq}`,
      scope,
      commitSeq,
      memoryId: options.memoryId,
      operation: options.operation ?? (previous === undefined ? "create" : "update"),
      baseRevision: previous?.currentRevision ?? null,
      newRevision: revision,
      idempotencyKey: `obsidian-${options.memoryId}-${revision}`,
      author: { lifeDid: scope.lifeDid, agentId: "nancy" },
      committedAt,
      payloadHash: `payload-hash-${options.memoryId}-${revision}`,
    });
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("DLMF-OBSIDIAN-001 exports a deterministic read-only native Obsidian graph", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlmf-obsidian-projection-"));
  try {
    const store = new InMemoryCanonicalMemoryStore();
    const preferenceId = "mem_obsidian_preference" as MemoryId;
    const projectId = "mem_obsidian_project" as MemoryId;
    await appendRevision(store, {
      memoryId: preferenceId,
      text: "使用者偏好簡短直接的溝通，但需要明確決策狀態。",
      memoryType: "preference",
      memoryKind: "communication_style",
      semanticKey: "preference:user:communication_style",
      sourceId: "session-shared",
    });
    await appendRevision(store, {
      memoryId: projectId,
      text: "DLMF historical migration is paused at Direct3700 pending memory governance.",
      memoryType: "project_state",
      memoryKind: "dlmf_historical_migration",
      semanticKey: "project:dlmf:historical_migration",
      sourceId: "session-shared",
    });

    await mkdir(join(root, "Notes"), { recursive: true });
    await writeFile(join(root, "Notes", "manual.md"), "# Human note\n", "utf8");

    const projection = new ObsidianMemoryProjection({ store, scope, vaultRoot: root });
    const first = await projection.export();
    assert.equal(first.manifest.activeMemoryCount, 2);
    assert.equal(first.manifest.excluded.length, 0);
    assert.equal(first.manifest.notes.length, 2);
    assert.ok(first.manifest.supportingNotes.length >= 6);
    assert.equal(first.manifest.edgeTypes.includes("derived_from"), true);
    assert.equal(first.manifest.edgeTypes.includes("belongs_to_project"), true);
    assert.equal(first.manifest.edgeTypes.includes("contradicts"), true);
    assert.equal(first.manifest.edgeTypes.includes("supersedes"), true);

    const preference = first.manifest.notes.find((note) => note.memoryId === preferenceId);
    const project = first.manifest.notes.find((note) => note.memoryId === projectId);
    assert.equal(preference?.path, `Memories/${preferenceId}.md`);
    assert.equal(project?.path, `Memories/${projectId}.md`);
    assert.ok(preference?.edges.some((edge) => edge.type === "derived_from"));
    assert.ok(preference?.edges.some((edge) => edge.type === "concerns"));
    assert.ok(project?.edges.some((edge) => edge.type === "belongs_to_project"));

    const preferenceText = await readFile(join(root, preference!.path), "utf8");
    assert.match(preferenceText, /revision: 1/);
    assert.match(preferenceText, /status: "active"/);
    assert.match(preferenceText, /`derived_from` \[\[Sources\//);
    assert.match(preferenceText, /`concerns` \[\[People\//);

    const sourceNode = first.manifest.supportingNotes.find((note) => note.kind === "source");
    assert.ok(sourceNode);
    assert.equal(sourceNode!.edges.filter((edge) => edge.type === "supports").length, 2);
    const sourceText = await readFile(join(root, sourceNode!.path), "utf8");
    assert.match(sourceText, /`supports` \[\[Memories\/mem_obsidian_preference\]\]/);
    assert.match(sourceText, /`supports` \[\[Memories\/mem_obsidian_project\]\]/);

    const manifestText = await readFile(join(root, "dlmf-manifest.json"), "utf8");
    assert.equal(manifestText.includes("generatedAt"), false);
    assert.equal(await exists(join(root, "Notes", "manual.md")), true);

    const second = await projection.export();
    assert.deepEqual(second.written, []);
    assert.deepEqual(second.removed, []);
    assert.equal(second.unchanged.length, first.written.length);

    await appendRevision(store, {
      memoryId: preferenceId,
      text: "使用者偏好簡短直接的溝通，並要求明確列出 PASS 或 HOLD。",
      memoryType: "preference",
      memoryKind: "communication_style",
      semanticKey: "preference:user:communication_style",
      sourceId: "session-shared",
    });
    const updated = await projection.export();
    assert.equal(updated.manifest.activeMemoryCount, 2);
    assert.ok(updated.written.includes(`Memories/${preferenceId}.md`));
    assert.equal(updated.manifest.notes.filter((note) => note.memoryId === preferenceId).length, 1);
    assert.match(
      await readFile(join(root, `Memories/${preferenceId}.md`), "utf8"),
      /revision: 2/,
    );

    await appendRevision(store, {
      memoryId: projectId,
      text: "DLMF historical migration project-state memory was invalidated.",
      memoryType: "project_state",
      memoryKind: "dlmf_historical_migration",
      semanticKey: "project:dlmf:historical_migration",
      sourceId: "session-shared",
      status: "tombstoned",
      operation: "tombstone",
    });
    const tombstoned = await projection.export();
    assert.equal(tombstoned.manifest.activeMemoryCount, 1);
    assert.deepEqual(tombstoned.manifest.excluded, [{
      memoryId: projectId,
      revision: 2,
      status: "tombstoned",
    }]);
    assert.equal(await exists(join(root, `Memories/${projectId}.md`)), false);
    assert.ok(tombstoned.removed.includes(`Memories/${projectId}.md`));
    assert.equal(await exists(join(root, "Notes", "manual.md")), true);

    const finalManifest = JSON.parse(await readFile(join(root, "dlmf-manifest.json"), "utf8"));
    assert.equal(finalManifest.notes.some((note: { memoryId: string }) => note.memoryId === projectId), false);
    assert.equal(finalManifest.excluded[0].status, "tombstoned");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
