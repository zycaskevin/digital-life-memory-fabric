import assert from "node:assert/strict";
import test from "node:test";

import {
  CoreObservationError,
  coreManifestDigest,
  expectedMemoryScopeRef,
  projectDlmfCoreObservations,
} from "../scripts/core-health-observation-lib.mjs";

const DLI = `digital-life-identity:root:${"a".repeat(64)}`;
const SCOPE = { tenantId: "tenant-a", lifeDid: "did:example:memory-a", memoryNamespace: "life" };
const AT = "2026-09-17T10:00:00.000Z";
const NOW = new Date(AT);

function manifest() {
  return {
    schema: "digital-life.component.v1",
    componentId: "dlmf-a",
    componentType: "memory-runtime",
    contract: "dlmf/digital-life-stack/v1",
    contractVersion: "1",
    binding: { scope: "digital-life", lifeDid: DLI },
    operations: ["experience.ingest", "retrieval.verify", "health"],
    capabilities: [], authorityClaims: ["memory.canonical"],
    endpoint: "http://127.0.0.1:29004",
    health: { protocol: "digital-life.health.v1", endpoint: "http://127.0.0.1:29004/health", readinessEndpoint: "http://127.0.0.1:29004/ready" },
  };
}
function identityBinding() {
  return {
    schema: "lifetime-hub.component-observation-binding.v1",
    authority: "lifetime-hub",
    lifeDid: DLI,
    companionId: "companion-a",
    definitionHash: "b".repeat(64),
    bindingKind: "memory-scope",
    bindingRef: expectedMemoryScopeRef(SCOPE),
    identityVerified: true,
    activationAuthorized: false,
  };
}
function native(ready = true) {
  return {
    ok: ready,
    service: "dlmf-digital-life-stack-ingress",
    contract: "dlmf/digital-life-stack/v1",
    canonicalAuthority: "digital-life-memory-fabric",
    observedAt: AT,
    scopeBound: true,
    scope: structuredClone(SCOPE),
    schemaState: ready ? "current-0008" : "stale-0007",
  };
}
function project(overrides = {}) {
  const m = manifest();
  return projectDlmfCoreObservations({
    componentManifest: m,
    manifestDigest: coreManifestDigest(m),
    expectedLifeDid: DLI,
    expectedScope: SCOPE,
    identityBinding: identityBinding(),
    health: { ...native(true), schemaState: undefined },
    readiness: native(true),
    now: NOW,
    ...overrides,
  });
}

test("DLMF projection binds DLI separately from Memory scope", () => {
  const result = project();
  assert.equal(result.health.binding.lifeDid, DLI);
  assert.notEqual(result.health.binding.lifeDid, SCOPE.lifeDid);
  assert.equal(result.health.ready, true);
  assert.equal(result.readiness.ready, true);
});

test("DLMF projection keeps native not-ready as degraded", () => {
  const result = project({ readiness: native(false) });
  assert.equal(result.health.status, "healthy");
  assert.equal(result.readiness.status, "degraded");
  assert.equal(result.readiness.ready, false);
});

test("DLMF projection rejects wrong native memory scope", () => {
  const health = { ...native(true), scope: { ...SCOPE, lifeDid: "did:example:other" }, schemaState: undefined };
  assert.throws(() => project({ health }), (error) => error instanceof CoreObservationError && error.code === "NATIVE_DLMF_BINDING_INVALID");
});

test("DLMF projection rejects wrong canonical DLI binding", () => {
  const binding = { ...identityBinding(), lifeDid: `digital-life-identity:root:${"c".repeat(64)}` };
  assert.throws(() => project({ identityBinding: binding }), (error) => error instanceof CoreObservationError && error.code === "DLMF_IDENTITY_BINDING_INVALID");
});

test("DLMF projection rejects a stale native sample", () => {
  const health = { ...native(true), observedAt: "2026-09-17T09:58:00.000Z", schemaState: undefined };
  assert.throws(() => project({ health }), (error) => error instanceof CoreObservationError && error.code === "NATIVE_OBSERVATION_STALE");
});
