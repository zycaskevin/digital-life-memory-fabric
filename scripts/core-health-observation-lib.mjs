import { createHash } from "node:crypto";

export class CoreObservationError extends Error {
  constructor(code) {
    super(code);
    this.name = "CoreObservationError";
    this.code = code;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = canonical(value[key]);
    }
    return out;
  }
  return value;
}

export function coreManifestDigest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex")}`;
}

function exactScope(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && typeof value.tenantId === "string" && value.tenantId.length > 0
    && typeof value.lifeDid === "string" && value.lifeDid.length > 0
    && typeof value.memoryNamespace === "string" && value.memoryNamespace.length > 0
    && Object.keys(value).sort().join(",") === "lifeDid,memoryNamespace,tenantId";
}

function sameScope(left, right) {
  return left.tenantId === right.tenantId
    && left.lifeDid === right.lifeDid
    && left.memoryNamespace === right.memoryNamespace;
}

export function expectedMemoryScopeRef(scope) {
  if (!exactScope(scope)) throw new CoreObservationError("DLMF_SCOPE_INVALID");
  return `dlmf://scope/${scope.lifeDid}/${scope.memoryNamespace}`;
}

export function verifyDlmfCoreManifest(manifest, expectedLifeDid, expectedDigest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new CoreObservationError("MANIFEST_INVALID");
  }
  if (coreManifestDigest(manifest) !== expectedDigest) {
    throw new CoreObservationError("MANIFEST_PIN_MISMATCH");
  }
  if (manifest.schema !== "digital-life.component.v1"
      || manifest.componentType !== "memory-runtime"
      || manifest.contract !== "dlmf/digital-life-stack/v1"
      || manifest.contractVersion !== "1"
      || manifest.binding?.scope !== "digital-life"
      || manifest.binding?.lifeDid !== expectedLifeDid
      || typeof manifest.componentId !== "string" || manifest.componentId.length === 0) {
    throw new CoreObservationError("MANIFEST_TARGET_MISMATCH");
  }
  return manifest;
}

function parseTime(value) {
  if (typeof value !== "string" || value.length > 40) throw new CoreObservationError("NATIVE_OBSERVATION_STALE");
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new CoreObservationError("NATIVE_OBSERVATION_STALE");
  return millis;
}

function verifyNative(native, expectedScope, kind, now) {
  if (!native || typeof native !== "object" || Array.isArray(native)
      || native.service !== "dlmf-digital-life-stack-ingress"
      || native.contract !== "dlmf/digital-life-stack/v1"
      || native.canonicalAuthority !== "digital-life-memory-fabric"
      || native.scopeBound !== true
      || !exactScope(native.scope)
      || !sameScope(native.scope, expectedScope)) {
    throw new CoreObservationError("NATIVE_DLMF_BINDING_INVALID");
  }
  const ageSeconds = (now.getTime() - parseTime(native.observedAt)) / 1000;
  if (ageSeconds < -5 || ageSeconds > 60) throw new CoreObservationError("NATIVE_OBSERVATION_STALE");
  if (kind === "health") {
    if (native.ok !== true) throw new CoreObservationError("NATIVE_DLMF_UNHEALTHY");
  } else if (typeof native.ok !== "boolean" || typeof native.schemaState !== "string") {
    throw new CoreObservationError("NATIVE_DLMF_READINESS_INVALID");
  }
}

export function projectDlmfCoreObservations({
  componentManifest,
  manifestDigest,
  expectedLifeDid,
  expectedScope,
  identityBinding,
  health,
  readiness,
  now = new Date(),
}) {
  verifyDlmfCoreManifest(componentManifest, expectedLifeDid, manifestDigest);
  if (!exactScope(expectedScope)) throw new CoreObservationError("DLMF_SCOPE_INVALID");
  const expectedRef = expectedMemoryScopeRef(expectedScope);
  if (!identityBinding || typeof identityBinding !== "object"
      || identityBinding.schema !== "lifetime-hub.component-observation-binding.v1"
      || identityBinding.authority !== "lifetime-hub"
      || identityBinding.identityVerified !== true
      || identityBinding.activationAuthorized !== false
      || identityBinding.lifeDid !== expectedLifeDid
      || identityBinding.bindingKind !== "memory-scope"
      || identityBinding.bindingRef !== expectedRef) {
    throw new CoreObservationError("DLMF_IDENTITY_BINDING_INVALID");
  }
  verifyNative(health, expectedScope, "health", now);
  verifyNative(readiness, expectedScope, "readiness", now);

  const observedAt = new Date(Math.min(parseTime(health.observedAt), parseTime(readiness.observedAt))).toISOString();
  const ready = readiness.ok === true && readiness.schemaState === "current-0008";
  const base = {
    schema: "digital-life.health.v1",
    componentId: componentManifest.componentId,
    contract: "dlmf/digital-life-stack/v1",
    contractVersion: "1",
    binding: { scope: "digital-life", lifeDid: expectedLifeDid },
    manifestDigest,
    observedAt,
  };
  return {
    health: { ...base, status: "healthy", ready: true },
    readiness: { ...base, status: ready ? "healthy" : "degraded", ready },
  };
}
