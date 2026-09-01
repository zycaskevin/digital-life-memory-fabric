import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import {
  CanonicalMemoryAuthority,
  CanonicalVerifier,
  MemoryCandidateService,
  PostgresCanonicalMemoryStore,
  RevisionConflictError,
  type MemoryScope,
} from "../src/index.js";

const databaseUrl = process.env.DLFM_TEST_DATABASE_URL;
const maybeTest = databaseUrl === undefined ? test.skip : test;

maybeTest("PostgreSQL canonical core E2E preserves commit/revision/conflict/tombstone contracts", async () => {
  assert.ok(databaseUrl);
  const schema = `dlfm_test_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({ connectionString: databaseUrl });
  await adminPool.query(`CREATE SCHEMA "${schema}"`);

  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  });
  const store = new PostgresCanonicalMemoryStore(pool);

  try {
    const migration = await readFile("migrations/0001_canonical_core.sql", "utf8");
    await pool.query(migration);

    const candidates = new MemoryCandidateService(store);
    const authority = new CanonicalMemoryAuthority(store);
    const verifier = new CanonicalVerifier(store);
    const scope: MemoryScope = {
      tenantId: "tenant_pg",
      lifeDid: "did:life:nancy",
      memoryNamespace: "life.core",
    };

    const createCandidate = await candidates.ingest({
      scope,
      origin: {
        lifeDid: scope.lifeDid,
        agentId: "nancy",
        runtimeId: "hermes-gb10",
        deviceId: "gb10",
      },
      candidateType: "semantic_assertion",
      sourceType: "conversation",
      sourceId: "conversation:pg:1",
      memoryClass: "semantic_assertion",
      memoryKind: "architecture_boundary",
      proposedContent: { text: "OmniHarness does not own Agent orchestration." },
      evidenceRefs: [
        { sourceType: "conversation", sourceRef: "conversation:pg:1" },
      ],
      proposedOperation: "create",
    });

    const created = await authority.commit({
      candidateId: createCandidate.candidateId,
      idempotencyKey: "pg-create-1",
    });
    assert.equal(created.revision.revision, 1);
    assert.equal(created.change.commitSeq, 1);

    const retry = await authority.commit({
      candidateId: createCandidate.candidateId,
      idempotencyKey: "pg-create-1",
    });
    assert.equal(retry.change.eventId, created.change.eventId);

    const updateCandidate = await candidates.ingest({
      scope,
      origin: { lifeDid: scope.lifeDid, runtimeId: "prime-mac", deviceId: "mac" },
      candidateType: "semantic_assertion_correction",
      sourceType: "conversation",
      sourceId: "conversation:pg:2",
      memoryClass: "semantic_assertion",
      memoryKind: "architecture_boundary",
      proposedContent: {
        text: "OmniHarness is provider abstraction only and does not own Agent orchestration.",
      },
      evidenceRefs: [
        { sourceType: "conversation", sourceRef: "conversation:pg:2" },
      ],
      proposedOperation: "update",
      baseMemoryId: created.head.memoryId,
      baseRevision: 1,
    });
    const updated = await authority.commit({
      candidateId: updateCandidate.candidateId,
      idempotencyKey: "pg-update-2",
    });
    assert.equal(updated.revision.revision, 2);
    assert.equal(updated.change.commitSeq, 2);

    const staleCandidate = await candidates.ingest({
      scope,
      origin: { lifeDid: scope.lifeDid, runtimeId: "offline-mac", deviceId: "mac" },
      candidateType: "semantic_assertion_correction",
      sourceType: "conversation",
      sourceId: "conversation:pg:stale",
      memoryClass: "semantic_assertion",
      memoryKind: "architecture_boundary",
      proposedContent: { text: "Stale edit." },
      evidenceRefs: [
        { sourceType: "conversation", sourceRef: "conversation:pg:stale" },
      ],
      proposedOperation: "update",
      baseMemoryId: created.head.memoryId,
      baseRevision: 1,
    });
    await assert.rejects(
      authority.commit({
        candidateId: staleCandidate.candidateId,
        idempotencyKey: "pg-stale",
      }),
      RevisionConflictError,
    );
    assert.equal((await store.getCandidate(staleCandidate.candidateId))?.status, "CONFLICT");
    assert.equal((await store.listConflicts(scope)).length, 1);

    const tombstoneCandidate = await candidates.ingest({
      scope,
      origin: { lifeDid: scope.lifeDid, runtimeId: "hermes-gb10", deviceId: "gb10" },
      candidateType: "deletion_request",
      sourceType: "user_explicit_statement",
      sourceId: "conversation:pg:delete",
      memoryClass: "semantic_assertion",
      memoryKind: "architecture_boundary",
      proposedContent: { text: "Delete this canonical memory." },
      evidenceRefs: [
        {
          sourceType: "user_explicit_statement",
          sourceRef: "conversation:pg:delete",
        },
      ],
      proposedOperation: "tombstone",
      baseMemoryId: created.head.memoryId,
      baseRevision: 2,
    });
    const tombstoned = await authority.commit({
      candidateId: tombstoneCandidate.candidateId,
      idempotencyKey: "pg-tombstone",
    });
    assert.equal(tombstoned.revision.revision, 3);
    assert.equal(tombstoned.change.commitSeq, 3);
    assert.deepEqual(await verifier.verify(created.head.memoryId, scope), {
      decision: "SUPPRESS",
      reason: "TOMBSTONED",
    });

    assert.deepEqual(
      (await store.listChangesAfter(scope, 0)).map((change) => change.commitSeq),
      [1, 2, 3],
    );
  } finally {
    await store.close();
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool.end();
  }
});
