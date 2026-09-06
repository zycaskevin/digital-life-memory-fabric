import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import test from "node:test";

interface DeploymentCheckResult {
  ok: boolean;
  errors: string[];
  publicSummary: string[];
}

type DeploymentChecker = (
  text: string,
  options?: { rootDir?: string; exists?: (path: string) => boolean },
) => DeploymentCheckResult;

const moduleUrl = pathToFileURL(
  resolve("scripts/relationship-os-ingress-config-lib.mjs"),
).href;
const deploymentModule = await import(moduleUrl) as {
  checkRelationshipOsIngressConfig: DeploymentChecker;
};
const check = deploymentModule.checkRelationshipOsIngressConfig;

const validEnv = `
DLMF_RELATIONSHIP_OS_HOST=127.0.0.1
DLMF_RELATIONSHIP_OS_PORT=8793
DLMF_RELATIONSHIP_OS_SCHEMA=dlmf_relationship_os
DLMF_RELATIONSHIP_OS_NAMESPACE_PREFIX=relationship.private.
DLMF_RELATIONSHIP_OS_HINDSIGHT_BANK_PREFIX=dlmf-ros-nancy
DLMF_RELATIONSHIP_OS_AGENT_ID=nancy
DLMF_RELATIONSHIP_OS_DATABASE_URL=postgresql://dlmf:test@127.0.0.1:5432/dlmf
DLMF_RELATIONSHIP_OS_ARCHIVE_ROOT=/var/lib/dlmf/relationship-os/raw
DLMF_RELATIONSHIP_OS_BEARER_TOKEN=0123456789abcdef0123456789abcdef
DLMF_RELATIONSHIP_OS_TENANT_ID=relationship-os-production
DLMF_RELATIONSHIP_OS_LIFE_DID=did:arthurverse:nancy
DLMF_RELATIONSHIP_OS_HINDSIGHT_URL=http://127.0.0.1:8888
DLMF_RELATIONSHIP_OS_HINDSIGHT_API_KEY=abcdef0123456789abcdef0123456789
OMNIHARNESS_DIR=/workspace/OmniHarness
`;

test("Relationship OS DLMF deployment preflight accepts protected loopback production shape", () => {
  const result = check(validEnv);
  assert.equal(result.ok, true, result.errors.join("\n"));
  const summary = result.publicSummary.join("\n");
  assert.match(summary, /DLMF_RELATIONSHIP_OS_CONFIG_PREFLIGHT=PASS/u);
  assert.match(summary, /canonical_authority=dlmf/u);
  assert.equal(summary.includes("postgresql://dlmf:test"), false);
  assert.equal(summary.includes("0123456789abcdef"), false);
});

test("Relationship OS DLMF deployment preflight rejects unsafe transport, archive, and placeholders", () => {
  const transport = check(
    validEnv.replace(
      "DLMF_RELATIONSHIP_OS_HINDSIGHT_URL=http://127.0.0.1:8888",
      "DLMF_RELATIONSHIP_OS_HINDSIGHT_URL=http://hindsight.example.test:8888",
    ),
  );
  assert.equal(transport.ok, false);
  assert.ok(transport.errors.includes("dlmf_relationship_os_hindsight_url_invalid"));

  const archive = check(
    validEnv.replace(
      "/var/lib/dlmf/relationship-os/raw",
      "/workspace/digital-life-memory-fabric/private-raw",
    ),
  );
  assert.equal(archive.ok, false);
  assert.ok(archive.errors.includes("dlmf_relationship_os_archive_root_invalid"));

  const placeholder = check(
    validEnv.replace(
      "DLMF_RELATIONSHIP_OS_TENANT_ID=relationship-os-production",
      "DLMF_RELATIONSHIP_OS_TENANT_ID=REPLACE_WITH_TENANT",
    ),
  );
  assert.equal(placeholder.ok, false);
  assert.ok(
    placeholder.errors.includes(
      "dlmf_relationship_os_env_unresolved:DLMF_RELATIONSHIP_OS_TENANT_ID",
    ),
  );
});
