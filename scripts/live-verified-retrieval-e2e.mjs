import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Pool } from "pg";

const execFileAsync = promisify(execFile);

const databaseUrl = requiredEnvironment("DLFM_TEST_DATABASE_URL");
const omniHarnessDir = resolve(requiredEnvironment("OMNIHARNESS_DIR"));
const hindsightUrl = requiredEnvironment("OMNIHARNESS_HINDSIGHT_URL");
const expectedOmniHarnessVersion =
  process.env.OMNIHARNESS_EXPECTED_VERSION ?? "0.2.0";
const expectedOmniHarnessCommit =
  process.env.OMNIHARNESS_EXPECTED_COMMIT ??
  "c1ed422adabc731a75270d9f572db9eed63b34ec";
const expectedHindsightVersion =
  process.env.OMNIHARNESS_HINDSIGHT_EXPECTED_VERSION ?? "0.9.2";

const { stdout: omniHarnessHeadOutput } = await execFileAsync(
  "git",
  ["-C", omniHarnessDir, "rev-parse", "HEAD"],
  { encoding: "utf8" },
);
const omniHarnessCommit = omniHarnessHeadOutput.trim();
assert.equal(omniHarnessCommit, expectedOmniHarnessCommit);
const { stdout: omniHarnessStatus } = await execFileAsync(
  "git",
  ["-C", omniHarnessDir, "status", "--porcelain=v1", "--untracked-files=all"],
  { encoding: "utf8" },
);
assert.equal(
  omniHarnessStatus,
  "",
  "OmniHarness worktree must be clean for the live contract gate",
);

const packageJson = JSON.parse(
  await readFile(resolve(omniHarnessDir, "package.json"), "utf8"),
);
assert.equal(packageJson.version, expectedOmniHarnessVersion);

const dlfm = await import(new URL("../dist/index.js", import.meta.url));
const omniHarness = await import(
  pathToFileURL(resolve(omniHarnessDir, "dist/index.js")).href
);

const schema = `dlfm_retrieval_${randomUUID().replaceAll("-", "")}`;
const adminPool = new Pool({ connectionString: databaseUrl });
let schemaCreated = false;
let store;
let provider;
let scope;
const providerMemoryIds = [];

try {
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  });
  store = new dlfm.PostgresCanonicalMemoryStore(pool);

  for (const migration of [
    "migrations/0001_canonical_core.sql",
    "migrations/0002_central_operations.sql",
  ]) {
    await pool.query(await readFile(migration, "utf8"));
  }

  provider = new omniHarness.HindsightMemoryProvider({
    baseUrl: hindsightUrl,
    bankId: `dlfm-retrieval-${randomUUID()}`,
    llmDependentFeatureAvailability: "unavailable",
  });
  const capabilities = await provider.capabilities();
  assert.equal(capabilities.version, expectedHindsightVersion);
  assert.ok(
    capabilities.features.includes(omniHarness.memoryFeatures.retrievalCandidates),
  );

  const registry = new omniHarness.ProviderRegistry();
  registry.register(provider);
  const consumer = new omniHarness.MemoryFabricMaterializationConsumer(registry);
  const resolver = new omniHarness.MemoryProviderResolver(registry);
  const candidates = new dlfm.MemoryCandidateService(store);
  const authority = new dlfm.CanonicalMemoryAuthority(store);
  const operations = new dlfm.CentralOperationsService(store);
  const verifier = new dlfm.CanonicalVerifier(store);
  const worker = new dlfm.MaterializationWorker(operations, {
    execute: (event) => consumer.execute(event),
  });
  scope = {
    tenantId: "tenant_dlfm_live",
    lifeDid: "did:life:nancy",
    memoryNamespace: `dlfm-005b.${randomUUID()}`,
  };
  const workerInput = {
    scope,
    workerId: "dlfm-005b-live-worker",
    leaseMs: 30_000,
    deliveryTimeoutMs: 10_000,
    retryDelayMs: 60_000,
  };

  const current = await commitCandidate(candidates, authority, {
    scope,
    sourceId: "dlfm-005b:live:current",
    operation: "create",
    content:
      "DLFM005BVERIFIED current canonical memory is hydrated after provider search.",
  });
  providerMemoryIds.push(current.head.memoryId);
  await assertMaterialized(worker, workerInput, current.change.eventId);

  const stale = await commitCandidate(candidates, authority, {
    scope,
    sourceId: "dlfm-005b:live:stale:create",
    operation: "create",
    content: "DLFM005BVERIFIED stale provider revision must be suppressed.",
  });
  providerMemoryIds.push(stale.head.memoryId);
  await assertMaterialized(worker, workerInput, stale.change.eventId);

  const deleted = await commitCandidate(candidates, authority, {
    scope,
    sourceId: "dlfm-005b:live:tombstone:create",
    operation: "create",
    content: "DLFM005BVERIFIED tombstoned canonical memory must be suppressed.",
  });
  providerMemoryIds.push(deleted.head.memoryId);
  await assertMaterialized(worker, workerInput, deleted.change.eventId);

  await commitCandidate(candidates, authority, {
    scope,
    sourceId: "dlfm-005b:live:stale:update",
    operation: "update",
    content: "The canonical revision advanced while provider materialization stayed stale.",
    memoryId: stale.head.memoryId,
    baseRevision: 1,
  });
  await commitCandidate(candidates, authority, {
    scope,
    sourceId: "dlfm-005b:live:tombstone",
    operation: "tombstone",
    content: "Tombstone the provider-visible memory.",
    memoryId: deleted.head.memoryId,
    baseRevision: 1,
  });

  let rawSearch;
  const retrievalPort = {
    async search(request, options) {
      assert.equal(options.signal.aborted, false);
      const resolved = await resolver.resolve("search", {
        requiredFeatures: [omniHarness.memoryFeatures.retrievalCandidates],
        allowFallback: true,
        ...(options.freshness === undefined
          ? {}
          : { freshness: options.freshness }),
      });
      assert.equal(resolved.length, 1);
      rawSearch = await resolved[0].search(request);
      return rawSearch;
    },
  };
  const retrieval = new dlfm.VerifiedRetrievalService(verifier, retrievalPort);
  const result = await retrieval.retrieve({
    query: "DLFM005BVERIFIED",
    scope,
    topK: 20,
  });

  assert.ok(rawSearch);
  assert.equal(rawSearch.providerId, "hindsight");
  assert.deepEqual(
    new Set(rawSearch.candidates.map((item) => item.memoryId)),
    new Set(providerMemoryIds),
  );
  assert.deepEqual(result.items.map((item) => item.memoryId), [
    current.head.memoryId,
  ]);
  assert.equal(
    result.items[0].revision.canonicalContent.text,
    "DLFM005BVERIFIED current canonical memory is hydrated after provider search.",
  );
  assert.equal(result.items[0].retrievalEvidence.providerId, "hindsight");
  assert.equal(result.verification.suppressionCounts.REVISION_MISMATCH, 1);
  assert.equal(result.verification.suppressionCounts.TOMBSTONED, 1);

  console.log(
    JSON.stringify(
      {
        e2e: "dlfm-005b-verified-retrieval",
        status: "passed",
        contracts: {
          memoryFabricBase: "origin/main@6896c9e",
          omniHarnessVersion: packageJson.version,
          omniHarnessCommit,
          hindsightVersion: capabilities.version,
        },
        path: [
          "canonical-postgresql",
          "omniharness-memory.search",
          "hindsight-retrieval-candidates",
          "canonical-verification",
          "canonical-hydration",
        ],
        acceptance: {
          currentRevisionHydrated: "passed",
          staleRevisionSuppressed: "passed",
          tombstoneSuppressedWhileProviderStillReturnsIt: "passed",
          providerContentCannotBecomeCanonical: "passed",
        },
        nonClaims: [
          "provider-wide freshness",
          "production deployment",
          "ContextProjection policy",
          "real runtime UAT",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  try {
    if (provider !== undefined && scope !== undefined) {
      for (const memoryId of providerMemoryIds) {
        try {
          await provider.deleteMaterialization({ memoryId, scope });
        } catch {
          // Cleanup is best effort; the bank ID is unique to this disposable run.
        }
      }
    }
    if (store !== undefined) await store.close();
  } finally {
    try {
      if (schemaCreated) {
        await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
    } finally {
      await adminPool.end();
    }
  }
}

async function commitCandidate(candidates, authority, input) {
  const candidate = await candidates.ingest({
    scope: input.scope,
    origin: {
      lifeDid: input.scope.lifeDid,
      runtimeId: "dlfm-005b-live-harness",
      deviceId: "local-e2e",
    },
    candidateType: `live_${input.operation}`,
    sourceType: "task_result",
    sourceId: input.sourceId,
    memoryClass: "episode",
    memoryKind: "verified_retrieval_acceptance",
    proposedContent: { text: input.content },
    evidenceRefs: [{ sourceType: "task_result", sourceRef: input.sourceId }],
    proposedOperation: input.operation,
    ...(input.memoryId === undefined ? {} : { baseMemoryId: input.memoryId }),
    ...(input.baseRevision === undefined ? {} : { baseRevision: input.baseRevision }),
  });
  return authority.commit({
    candidateId: candidate.candidateId,
    idempotencyKey: `${input.sourceId}:${randomUUID()}`,
  });
}

async function assertMaterialized(worker, input, eventId) {
  const run = await worker.runOnce(input);
  assert.equal(run.claimed, 1);
  assert.equal(run.items[0].event.event_id, eventId);
  assert.equal(
    run.items[0].receipt.status,
    "SUCCESS",
    JSON.stringify(run.items[0].receipt),
  );
  assert.equal(run.items[0].settlement.record.status, "DONE");
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}
