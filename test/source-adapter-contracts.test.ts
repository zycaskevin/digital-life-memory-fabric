import assert from "node:assert/strict";
import test from "node:test";
import {
  assertNormalizedExperience,
  experienceIdFor,
  sha256SourceFingerprint,
  type MemorySourceAdapter,
  type NormalizedExperience,
  type SourceIdentity,
} from "../src/index.js";

const source: SourceIdentity = {
  sourceSystem: "hermes",
  sourceType: "conversation",
  sourceId: "session-001",
};

test("experience identity is stable across source version changes", () => {
  const first = experienceIdFor(source);
  const second = experienceIdFor({ ...source });
  assert.equal(first, second);
  assert.match(first, /^exp_[a-f0-9]{64}$/);
});

test("different source systems cannot collide on the same source-local id", () => {
  assert.notEqual(
    experienceIdFor(source),
    experienceIdFor({ ...source, sourceSystem: "openclaw" }),
  );
});

test("experience identity rejects reserved tuple separators", () => {
  assert.throws(
    () => experienceIdFor({ ...source, sourceType: "conversation\u001fsession" }),
    /reserved identity separator/,
  );
  assert.throws(
    () => experienceIdFor({ ...source, sourceSystem: "hermes\u001fconversation" }),
    /reserved identity separator/,
  );
});

test("source fingerprint is deterministic and content-sensitive", () => {
  assert.deepEqual(sha256SourceFingerprint("same"), sha256SourceFingerprint("same"));
  assert.notDeepEqual(sha256SourceFingerprint("same"), sha256SourceFingerprint("changed"));
});

test("normalized experience preserves unknown time without inventing a timestamp", () => {
  const experienceId = experienceIdFor(source);
  const fingerprint = sha256SourceFingerprint("source-record");
  const value: NormalizedExperience = {
    sourceSystem: source.sourceSystem,
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    sourceVersion: { value: "42", scheme: "native" },
    experienceId,
    startedAt: { certainty: "unknown" },
    endedAt: { certainty: "inferred", value: "2026-09-12T00:00:00.000Z", evidence: "file mtime" },
    actors: [{ actorId: "user", kind: "user" }],
    events: [],
    content: [{ mediaType: "text/plain", text: "hello" }],
    metadata: {},
    provenance: {
      source,
      sourceVersion: { value: "42", scheme: "native" },
      sourceFingerprint: fingerprint,
      adapterName: "HermesSourceAdapter",
      adapterVersion: "0.1.0",
      discoveredAt: "2026-09-12T00:00:00.000Z",
      readAt: "2026-09-12T00:00:01.000Z",
      normalizedAt: "2026-09-12T00:00:02.000Z",
    },
  };
  assert.doesNotThrow(() => assertNormalizedExperience(value));
});

test("normalized experience rejects forged stable identity", () => {
  const experienceId = experienceIdFor(source);
  const value: NormalizedExperience = {
    sourceSystem: source.sourceSystem,
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    experienceId: experienceIdFor({ ...source, sourceId: "other" }),
    startedAt: { certainty: "unknown" },
    endedAt: { certainty: "unknown" },
    actors: [],
    events: [],
    content: [],
    metadata: {},
    provenance: {
      source,
      sourceFingerprint: sha256SourceFingerprint("x"),
      adapterName: "test",
      adapterVersion: "1",
      discoveredAt: "2026-09-12T00:00:00.000Z",
      readAt: "2026-09-12T00:00:00.000Z",
      normalizedAt: "2026-09-12T00:00:00.000Z",
    },
  };
  assert.notEqual(value.experienceId, experienceId);
  assert.throws(() => assertNormalizedExperience(value), /stable source identity/);
});

test("normalized experience rejects non-canonical source identity whitespace", () => {
  for (const field of ["sourceSystem", "sourceType", "sourceId"] as const) {
    const paddedSource = { ...source, [field]: ` ${source[field]}` };
    const value: NormalizedExperience = {
      sourceSystem: paddedSource.sourceSystem,
      sourceType: paddedSource.sourceType,
      sourceId: paddedSource.sourceId,
      experienceId: experienceIdFor(paddedSource),
      startedAt: { certainty: "unknown" },
      endedAt: { certainty: "unknown" },
      actors: [],
      events: [],
      content: [],
      metadata: {},
      provenance: {
        source: paddedSource,
        sourceFingerprint: sha256SourceFingerprint("x"),
        adapterName: "test",
        adapterVersion: "1",
        discoveredAt: "2026-09-12T00:00:00.000Z",
        readAt: "2026-09-12T00:00:00.000Z",
        normalizedAt: "2026-09-12T00:00:00.000Z",
      },
    };
    assert.throws(
      () => assertNormalizedExperience(value),
      new RegExp(`${field} must not contain surrounding whitespace`),
    );
  }
});

test("normalized experience rejects malformed provenance source fingerprints", () => {
  const experienceId = experienceIdFor(source);
  const value: NormalizedExperience = {
    sourceSystem: source.sourceSystem,
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    experienceId,
    startedAt: { certainty: "unknown" },
    endedAt: { certainty: "unknown" },
    actors: [],
    events: [],
    content: [],
    metadata: {},
    provenance: {
      source,
      sourceFingerprint: sha256SourceFingerprint("x"),
      adapterName: "test",
      adapterVersion: "1",
      discoveredAt: "2026-09-12T00:00:00.000Z",
      readAt: "2026-09-12T00:00:00.000Z",
      normalizedAt: "2026-09-12T00:00:00.000Z",
    },
  };
  const malformed = [
    { algorithm: "sha256", value: "x" },
    { algorithm: "md5", value: "a".repeat(64) },
  ] as unknown as Array<NormalizedExperience["provenance"]["sourceFingerprint"]>;

  for (const sourceFingerprint of malformed) {
    assert.throws(
      () => assertNormalizedExperience({
        ...value,
        provenance: { ...value.provenance, sourceFingerprint },
      }),
      /source fingerprint/,
    );
  }
});

test("normalized experience rejects exact time without a value", () => {
  const experienceId = experienceIdFor(source);
  const value: NormalizedExperience = {
    sourceSystem: source.sourceSystem,
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    experienceId,
    startedAt: { certainty: "exact" },
    endedAt: { certainty: "unknown" },
    actors: [],
    events: [],
    content: [],
    metadata: {},
    provenance: {
      source,
      sourceFingerprint: sha256SourceFingerprint("x"),
      adapterName: "test",
      adapterVersion: "1",
      discoveredAt: "2026-09-12T00:00:00.000Z",
      readAt: "2026-09-12T00:00:00.000Z",
      normalizedAt: "2026-09-12T00:00:00.000Z",
    },
  };
  assert.throws(() => assertNormalizedExperience(value), /exact timestamp/);
});


test("adapter contract supports a non-Hermes source without core schema changes", async () => {
  type MarkdownPayload = { body: string; modifiedAt?: string };
  const markdownSource: SourceIdentity = {
    sourceSystem: "obsidian",
    sourceType: "markdown_note",
    sourceId: "projects/dlmf.md",
  };
  const unitId = experienceIdFor(markdownSource);

  const adapter: MemorySourceAdapter<MarkdownPayload> = {
    name: "MarkdownSourceAdapter",
    version: "0.1.0",
    async inspect() {
      return {
        adapterName: this.name,
        adapterVersion: this.version,
        sourceSystem: "obsidian",
        sourceType: "markdown_note",
        capabilities: {
          historicalImport: "full",
          incrementalSync: "full",
          stableSourceId: "full",
          timestamps: "partial",
          toolEvents: "none",
          attachments: "partial",
          deletionDetection: "unknown",
        },
        metadata: {},
      };
    },
    async discover(request) {
      assert.equal(request.limit, 100);
      return {
        units: [{
          source: markdownSource,
          experienceId: unitId,
          startedAt: { certainty: "unknown" },
          endedAt: { certainty: "unknown" },
          metadata: {},
        }],
        nextCursor: "page-2",
      };
    },
    async read(unit) {
      return {
        unit,
        payload: { body: "# DLMF" },
        readAt: "2026-09-12T00:00:01.000Z",
      };
    },
    async fingerprint() {
      return sha256SourceFingerprint("# DLMF");
    },
    async normalize(result) {
      const sourceFingerprint = sha256SourceFingerprint(result.payload.body);
      return {
        sourceSystem: markdownSource.sourceSystem,
        sourceType: markdownSource.sourceType,
        sourceId: markdownSource.sourceId,
        experienceId: result.unit.experienceId,
        startedAt: { certainty: "unknown" },
        endedAt: { certainty: "unknown" },
        actors: [],
        events: [],
        content: [{ mediaType: "text/markdown", text: result.payload.body }],
        metadata: {},
        provenance: {
          source: markdownSource,
          sourceFingerprint,
          adapterName: this.name,
          adapterVersion: this.version,
          discoveredAt: "2026-09-12T00:00:00.000Z",
          readAt: result.readAt,
          normalizedAt: "2026-09-12T00:00:02.000Z",
        },
      };
    },
  };

  const inspection = await adapter.inspect();
  assert.equal(inspection.capabilities.toolEvents, "none");
  const page = await adapter.discover({ limit: 100 });
  assert.equal(page.nextCursor, "page-2");
  const read = await adapter.read(page.units[0]!);
  const normalized = await adapter.normalize(read);
  assert.doesNotThrow(() => assertNormalizedExperience(normalized));
});
