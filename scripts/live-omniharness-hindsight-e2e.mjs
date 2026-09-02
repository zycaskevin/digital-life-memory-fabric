import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";

const databaseUrl = requiredEnvironment("DLFM_TEST_DATABASE_URL");
const omniHarnessDir = resolve(requiredEnvironment("OMNIHARNESS_DIR"));
const hindsightUrl = requiredEnvironment("OMNIHARNESS_HINDSIGHT_URL");
const expectedOmniHarnessVersion =
  process.env.OMNIHARNESS_EXPECTED_VERSION ?? "0.2.0";
const expectedHindsightVersion =
  process.env.OMNIHARNESS_HINDSIGHT_EXPECTED_VERSION ?? "0.9.2";

const packageJson = JSON.parse(
  await readFile(resolve(omniHarnessDir, "package.json"), "utf8"),
);
assert.equal(
  packageJson.version,
  expectedOmniHarnessVersion,
  "OmniHarness package version does not match the pinned live contract",
);

const dlfm = await import(new URL("../dist/index.js", import.meta.url));
const omniHarness = await import(
  pathToFileURL(resolve(omniHarnessDir, "dist/index.js")).href
);

const schema = `dlfm_live_${randomUUID().replaceAll("-", "")}`;
const adminPool = new Pool({ connectionString: databaseUrl });
await adminPool.query(`CREATE SCHEMA "${schema}"`);
const pool = new Pool({
  connectionString: databaseUrl,
  options: `-c search_path=${schema}`,
});
const store = new dlfm.PostgresCanonicalMemoryStore(pool);
let bridge;

try {
  for (const migration of [
    "migrations/0001_canonical_core.sql",
    "migrations/0002_central_operations.sql",
  ]) {
    await pool.query(await readFile(migration, "utf8"));
  }

  const bankId = `dlfm-live-${randomUUID()}`;
  const provider = new omniHarness.HindsightMemoryProvider({
    baseUrl: hindsightUrl,
    bankId,
    llmDependentFeatureAvailability: "unavailable",
  });
  const capabilities = await provider.capabilities();
  assert.equal(capabilities.version, expectedHindsightVersion);
  assert.equal(capabilities.metadata?.canonicalAuthority, false);

  const registry = new omniHarness.ProviderRegistry();
  registry.register(provider);
  const consumer = new omniHarness.MemoryFabricMaterializationConsumer(registry);
  bridge = await startBridge(consumer);

  const delivery = new dlfm.HttpMemoryMaterializationDeliveryPort({
    endpoint: bridge.endpoint,
    maxResponseBytes: 1_048_576,
  });
  const candidates = new dlfm.MemoryCandidateService(store);
  const authority = new dlfm.CanonicalMemoryAuthority(store);
  const operations = new dlfm.CentralOperationsService(store);
  const verifier = new dlfm.CanonicalVerifier(store);
  const worker = new dlfm.MaterializationWorker(operations, delivery);
  const scope = {
    tenantId: "tenant_dlfm_live",
    lifeDid: "did:life:nancy",
    memoryNamespace: `dlfm-005a.${randomUUID()}`,
  };
  const workerInput = {
    scope,
    workerId: "dlfm-005a-live-worker",
    leaseMs: 30_000,
    deliveryTimeoutMs: 10_000,
    retryDelayMs: 60_000,
  };

  const created = await commitCandidate(candidates, authority, {
    scope,
    sourceId: "dlfm-005a:live:create",
    operation: "create",
    content: "DLFM-005A live materialization reaches Hindsight through OmniHarness.",
    idempotencyKey: `dlfm-005a-create-${randomUUID()}`,
  });
  const createRun = await worker.runOnce(workerInput);
  const createItem = onlyItem(createRun);
  assert.equal(createItem.event.event_id, created.change.eventId);
  assert.equal(createItem.receipt?.provider_id, "hindsight");
  assert.equal(createItem.receipt?.status, "SUCCESS");
  assert.equal(createItem.settlement.record.status, "DONE");

  const inspectedCreate = await provider.inspectMaterialization({
    memoryId: created.head.memoryId,
    scope,
  });
  assert.equal(inspectedCreate.state, "CURRENT");
  assert.equal(inspectedCreate.canonicalRevision, 1);
  assert.equal(inspectedCreate.materializedCommitSeq, 1);

  const replayReceipt = await delivery.execute(createItem.event);
  assert.equal(replayReceipt.status, "ALREADY_CURRENT");
  assert.equal(replayReceipt.canonical_commit_affected, false);

  const updated = await commitCandidate(candidates, authority, {
    scope,
    sourceId: "dlfm-005a:live:update",
    operation: "update",
    content: "DLFM-005A preserves canonical identity while replacing provider materialization.",
    memoryId: created.head.memoryId,
    baseRevision: 1,
    idempotencyKey: `dlfm-005a-update-${randomUUID()}`,
  });
  const updateItem = onlyItem(await worker.runOnce(workerInput));
  assert.equal(updateItem.receipt?.status, "SUCCESS");
  assert.equal(updateItem.settlement.record.status, "DONE");
  const inspectedUpdate = await provider.inspectMaterialization({
    memoryId: updated.head.memoryId,
    scope,
  });
  assert.equal(inspectedUpdate.state, "CURRENT");
  assert.equal(inspectedUpdate.canonicalRevision, 2);
  assert.equal(inspectedUpdate.materializedCommitSeq, 2);

  await commitCandidate(candidates, authority, {
    scope,
    sourceId: "dlfm-005a:live:tombstone",
    operation: "tombstone",
    content: "Tombstone the live E2E memory.",
    memoryId: created.head.memoryId,
    baseRevision: 2,
    idempotencyKey: `dlfm-005a-tombstone-${randomUUID()}`,
  });
  const deleteItem = onlyItem(await worker.runOnce(workerInput));
  assert.equal(deleteItem.event.intent, "DELETE");
  assert.equal(deleteItem.receipt?.status, "SUCCESS");
  assert.equal(
    (await provider.inspectMaterialization({ memoryId: created.head.memoryId, scope })).state,
    "MISSING",
  );
  assert.deepEqual(await verifier.verify(created.head.memoryId, scope), {
    decision: "SUPPRESS",
    reason: "TOMBSTONED",
  });

  const outageCommit = await commitCandidate(candidates, authority, {
    scope,
    sourceId: "dlfm-005a:live:outage",
    operation: "create",
    content: "Canonical commit survives an unavailable OmniHarness transport.",
    idempotencyKey: `dlfm-005a-outage-${randomUUID()}`,
  });
  await bridge.close();
  bridge = undefined;
  const outageItem = onlyItem(await worker.runOnce(workerInput));
  assert.equal(outageItem.settlement.record.status, "FAILED");
  assert.ok(outageItem.deliveryError);
  assert.equal((await verifier.verify(outageCommit.head.memoryId, scope)).decision, "ALLOW");
  const materializations = await operations.readProviderMaterializations({ scope });
  assert.equal(
    materializations.materializations.some(
      (item) => item.memoryId === outageCommit.head.memoryId,
    ),
    false,
  );

  console.log(
    JSON.stringify(
      {
        e2e: "dlfm-005a-live-materialization",
        status: "passed",
        contracts: {
          memoryFabric: "origin/main@2da8e26",
          omniHarnessVersion: packageJson.version,
          hindsightVersion: capabilities.version,
        },
        path: [
          "canonical-commit",
          "postgresql-outbox",
          "http-delivery",
          "omniharness-consumer",
          "hindsight",
          "correlated-settlement",
        ],
        acceptance: {
          create: "passed",
          idempotentReplay: "passed",
          update: "passed",
          tombstone: "passed",
          providerInspection: "passed",
          transportOutageDoesNotRollbackCanonicalCommit: "passed",
        },
        nonClaims: ["production deployment", "real runtime UAT", "verified retrieval"],
      },
      null,
      2,
    ),
  );
} finally {
  if (bridge !== undefined) await bridge.close();
  await store.close();
  await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await adminPool.end();
}

async function commitCandidate(candidates, authority, input) {
  const candidate = await candidates.ingest({
    scope: input.scope,
    origin: {
      lifeDid: input.scope.lifeDid,
      runtimeId: "dlfm-005a-live-harness",
      deviceId: "local-e2e",
    },
    candidateType: `live_${input.operation}`,
    sourceType: "task_result",
    sourceId: input.sourceId,
    memoryClass: "episode",
    memoryKind: "provider_delivery_acceptance",
    proposedContent: { text: input.content },
    evidenceRefs: [{ sourceType: "task_result", sourceRef: input.sourceId }],
    proposedOperation: input.operation,
    ...(input.memoryId === undefined ? {} : { baseMemoryId: input.memoryId }),
    ...(input.baseRevision === undefined ? {} : { baseRevision: input.baseRevision }),
  });
  return authority.commit({
    candidateId: candidate.candidateId,
    idempotencyKey: input.idempotencyKey,
  });
}

function onlyItem(run) {
  assert.equal(run.claimed, 1);
  assert.equal(run.items.length, 1);
  return run.items[0];
}

async function startBridge(consumer) {
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/v1/memory/materializations") {
        response.writeHead(404).end();
        return;
      }
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        response.writeHead(415).end();
        return;
      }
      const event = JSON.parse(await readRequest(request));
      assert.equal(request.headers["idempotency-key"], event.idempotency_key);
      assert.equal(request.headers["x-request-id"], event.request_id);
      const receipt = await consumer.execute(event);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(receipt));
    } catch {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "bridge execution failed" }));
    }
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1/memory/materializations`,
    close: () => new Promise((resolvePromise, reject) => {
      server.close((error) => (error ? reject(error) : resolvePromise()));
    }),
  };
}

async function readRequest(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 1_048_576) throw new Error("request too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}
