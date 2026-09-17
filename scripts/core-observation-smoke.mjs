#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { DigitalLifeStackDlmfIngress } from "../dist/integration/digital-life-stack-http.js";
import { coreManifestDigest, expectedMemoryScopeRef } from "./core-health-observation-lib.mjs";

const lifetimePath = process.env.LIFETIME_HUB_CORE_OBSERVATION_PYTHONPATH;
if (!lifetimePath) throw new Error("LIFETIME_HUB_CORE_OBSERVATION_PYTHONPATH is required");
const python = process.env.LIFETIME_HUB_CORE_OBSERVATION_PYTHON || "python3";
const root = await mkdtemp(join(tmpdir(), "dlmf-core-observation-"));
const db = join(root, "lifetime.sqlite3");
const manifestPath = join(root, "component.json");
const scopePath = join(root, "scope.json");
const outputPath = join(root, "observation.json");
const rootHash = "7".repeat(64);
const lifeDid = `digital-life-identity:root:${rootHash}`;
const scope = { tenantId: "tenant-core-003b", lifeDid: "did:core-003b:memory", memoryNamespace: "life" };
const memoryRef = expectedMemoryScopeRef(scope);

function hashFile(path) {
  return readFile(path).then((data) => createHash("sha256").update(data).digest("hex"));
}
function runPython(code, args = []) {
  const result = spawnSync(python, ["-c", code, ...args], {
    encoding: "utf8", timeout: 10_000,
    env: { ...process.env, PYTHONPATH: [resolve(lifetimePath), process.env.PYTHONPATH].filter(Boolean).join(":") },
  });
  if (result.status !== 0) throw new Error(`python failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

let server;
try {
  const companionId = runPython(`
from lifetime_hub import ContinuityStore, Provenance
from lifetime_hub.canonical import utc_now
import sys
root_hash, db, memory_ref = sys.argv[1:]
p = Provenance(source_type="digital-life-identity", source_id=root_hash, actor_id="core-003b", captured_at=utc_now(), evidence_refs=(f"identity-root:{root_hash}",))
with ContinuityStore(db) as store:
    c,_ = store.create_identity_companion(name="Core 003B Memory", identity_source=f"digital-life-identity:root:{root_hash}", provenance=p)
    store.create_agent_definition(companion_id=c.companion_id, runtime_contract_ref="life-runtime://core-003b", memory_scope_ref=memory_ref, personality_scope_ref="dld://core-003b", self_gateway_policy_ref="self-gateway://core-003b", capability_classes=("conversation",), provenance=Provenance(source_type="agent-definition", source_id="core-003b", actor_id="core-003b", captured_at=utc_now()))
    print(c.companion_id)
`, [rootHash, db, memoryRef]);

  const ingress = new DigitalLifeStackDlmfIngress({
    bearerToken: "core-003b-synthetic-token-that-is-at-least-32-bytes",
    agentId: "core-003b",
    runtimeId: "core-003b",
    allowedScope: scope,
    readiness: { async ready() { return { ready: true, schemaState: "current-0008" }; } },
    policies: { distillationPolicyVersion: "d", canonicalizationPolicyVersion: "c", admissionPolicyVersion: "a", retentionPolicyVersion: "r" },
    distillation: { async run() { throw new Error("observation must not distill"); } },
    retrieval: { async retrieve() { throw new Error("observation must not retrieve"); } },
  });
  server = createServer(async (request, response) => {
    const target = new Request(`http://127.0.0.1${request.url}`, { method: request.method });
    const result = await ingress.handle(target);
    response.statusCode = result.status;
    for (const [key, value] of result.headers) response.setHeader(key, value);
    response.end(Buffer.from(await result.arrayBuffer()));
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address invalid");
  const manifest = {
    schema: "digital-life.component.v1", componentId: "dlmf-core-003b", componentType: "memory-runtime",
    contract: "dlmf/digital-life-stack/v1", contractVersion: "1",
    binding: { scope: "digital-life", lifeDid },
    operations: ["experience.ingest", "retrieval.verify", "health"], capabilities: [], authorityClaims: ["memory.canonical"],
    endpoint: `http://127.0.0.1:${address.port}`,
    health: { protocol: "digital-life.health.v1", endpoint: `http://127.0.0.1:${address.port}/health`, readinessEndpoint: `http://127.0.0.1:${address.port}/ready` },
    metadata: { implementation: "digital-life-memory-fabric", evidenceKind: "synthetic" },
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(scopePath, `${JSON.stringify(scope, null, 2)}\n`);
  const before = await hashFile(db);
  const observe = await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [
      resolve("scripts/digital-life-core-observation.mjs"),
      "--manifest", manifestPath,
      "--life-did", lifeDid,
      "--scope", scopePath,
      "--lifetime-db", db,
      "--companion-id", companionId,
      "--lifetime-pythonpath", lifetimePath,
      "--python", python,
      "--output", outputPath,
    ], { encoding: "utf8" });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ status: code, stdout, stderr }));
  });
  if (observe.status !== 0) throw new Error(`observer failed: ${observe.stderr || observe.stdout}`);
  const after = await hashFile(db);
  const observations = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(before, after);
  assert.equal(observations.health.ready, true);
  assert.equal(observations.readiness.ready, true);
  assert.equal(observations.health.binding.lifeDid, lifeDid);
  assert.notEqual(observations.health.binding.lifeDid, scope.lifeDid);
  assert.equal(observations.health.manifestDigest, coreManifestDigest(manifest));
  console.log(JSON.stringify({
    result: "PASS", evidenceKind: "synthetic-native-process", scenarios: [
      "native-health-ready", "independent-dli-memory-scope", "lifetime-memory-binding",
      "scope-bound-ingress", "observation-no-lifetime-write", "no-memory-operation",
    ], lifetimeWrites: 0, memoryOperations: 0, attachmentAuthorized: false, productionUat: "NOT_RUN",
  }));
} finally {
  if (server) await new Promise((resolvePromise) => server.close(resolvePromise));
  await rm(root, { recursive: true, force: true });
}
