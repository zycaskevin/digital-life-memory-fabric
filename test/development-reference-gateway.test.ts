import assert from "node:assert/strict";
import test from "node:test";

import type {
  CanonicalMemoryHead,
  MemoryId,
  MemoryRevision,
  MemoryScope,
} from "../src/domain/types.js";
import {
  createDevelopmentReferenceEnvelope,
  DLMF_DEVELOPMENT_REFERENCE_SCHEMA,
  projectDevelopmentCanonicalReference,
} from "../src/integration/development-reference.js";
import { DlmfDevelopmentReferenceGateway } from "../src/integration/development-reference-http.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const SCOPE: MemoryScope = {
  tenantId: "tenant-arthur",
  lifeDid: "did:arthurverse:nancy",
  memoryNamespace: "life",
};
const OTHER_SCOPE: MemoryScope = {
  tenantId: "tenant-arthur",
  lifeDid: "did:arthurverse:other",
  memoryNamespace: "life",
};
const SECRET = "DLMF_PRIVATE_CANONICAL_CONTENT_DO_NOT_DELIVER";

function revision(
  revisionNumber: number,
  overrides: Partial<MemoryRevision> = {},
): MemoryRevision {
  return {
    memoryId: "mem_gateway_001",
    revision: revisionNumber,
    scope: SCOPE,
    memoryClass: "episode",
    memoryKind: "navigation_practice",
    status: "active",
    canonicalContent: {
      text: `${SECRET}:r${revisionNumber}`,
      payload: { privateRoute: "secret-route" },
    },
    contentHash: `sha256-gateway-r${revisionNumber}`,
    author: { lifeDid: SCOPE.lifeDid, agentId: "nancy" },
    provenance: {
      sourceType: "hermes-session",
      sourceId: "session-gateway-001",
      candidateId: "cand_gateway_001",
      candidateFingerprint: "candidate-gateway-001",
      producer: { kind: "runtime", id: "hermes" },
      sourceExperienceRefs: [
        {
          sourceType: "hermes-session",
          sourceId: "session-gateway-001",
          archiveRef: "archive://gateway/session-001",
          checksum: "sha256-source-gateway-001",
        },
      ],
    },
    evidenceRefs: [],
    epistemicStatus: "observed",
    producer: { kind: "runtime", id: "hermes" },
    sourceExperienceRefs: [
      {
        sourceType: "hermes-session",
        sourceId: "session-gateway-001",
        archiveRef: "archive://gateway/session-001",
        checksum: "sha256-source-gateway-001",
      },
    ],
    semanticFingerprint: "semantic-gateway-001",
    committedAt: `2026-09-06T03:0${revisionNumber}:00.000Z`,
    commitSeq: 100 + revisionNumber,
    observedAt: "2026-09-06T03:00:00.000Z",
    ...overrides,
  };
}

function head(overrides: Partial<CanonicalMemoryHead> = {}): CanonicalMemoryHead {
  return {
    memoryId: "mem_gateway_001",
    scope: SCOPE,
    memoryClass: "episode",
    memoryKind: "navigation_practice",
    currentRevision: 2,
    status: "active",
    createdAt: "2026-09-06T03:00:00.000Z",
    updatedAt: "2026-09-06T03:02:00.000Z",
    ...overrides,
  };
}

function gateway(options: {
  headValue?: CanonicalMemoryHead;
  revisions?: Readonly<Record<number, MemoryRevision>>;
  allowedScope?: MemoryScope;
  counters?: { heads: number; revisions: number };
} = {}): DlmfDevelopmentReferenceGateway {
  const headValue = options.headValue ?? head();
  const revisions = options.revisions ?? {
    1: revision(1),
    2: revision(2),
  };
  const counters = options.counters;
  return new DlmfDevelopmentReferenceGateway({
    bearerToken: TOKEN,
    allowedScope: options.allowedScope ?? SCOPE,
    store: {
      async getHead(memoryId: MemoryId) {
        if (counters !== undefined) counters.heads += 1;
        return memoryId === headValue.memoryId ? structuredClone(headValue) : undefined;
      },
      async getRevision(memoryId: MemoryId, revisionNumber: number) {
        if (counters !== undefined) counters.revisions += 1;
        if (memoryId !== headValue.memoryId) return undefined;
        const value = revisions[revisionNumber];
        return value === undefined ? undefined : structuredClone(value);
      },
    },
  });
}

function request(
  path: string,
  token = TOKEN,
): Request {
  return new Request(`http://127.0.0.1:8794${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

test("DLMF-owned projection excludes canonicalContent and payload", () => {
  const projected = projectDevelopmentCanonicalReference(revision(2));
  const envelope = createDevelopmentReferenceEnvelope(revision(2));

  assert.equal(projected.memoryId, "mem_gateway_001");
  assert.equal(projected.canonicalRevision, 2);
  assert.equal("canonicalContent" in projected, false);
  assert.equal("payload" in projected, false);
  assert.equal(JSON.stringify(projected).includes(SECRET), false);
  assert.equal(envelope.schema, DLMF_DEVELOPMENT_REFERENCE_SCHEMA);
  assert.equal(JSON.stringify(envelope).includes("secret-route"), false);
});

test("health endpoint is public but returns no memory data", async () => {
  const response = await gateway().handle(
    new Request("http://127.0.0.1:8794/health"),
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.service, "dlmf-development-reference-gateway");
  assert.equal(JSON.stringify(body).includes("memoryId"), false);
});

test("bearer auth is checked before store lookup", async () => {
  const counters = { heads: 0, revisions: 0 };
  const response = await gateway({ counters }).handle(
    request(
      "/v1/development/canonical-references/mem_gateway_001?revision=current",
      "wrong-wrong-wrong-wrong-wrong-wrong-token",
    ),
  );

  assert.equal(response.status, 401);
  assert.deepEqual(counters, { heads: 0, revisions: 0 });
});

test("current lookup returns metadata-only current canonical revision", async () => {
  const response = await gateway().handle(
    request(
      "/v1/development/canonical-references/mem_gateway_001?revision=current",
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const raw = await response.text();
  assert.equal(raw.includes(SECRET), false);
  assert.equal(raw.includes("secret-route"), false);
  const body = JSON.parse(raw) as {
    ok: boolean;
    envelope: { schema: string; reference: { canonicalRevision: number } };
  };
  assert.equal(body.ok, true);
  assert.equal(body.envelope.schema, DLMF_DEVELOPMENT_REFERENCE_SCHEMA);
  assert.equal(body.envelope.reference.canonicalRevision, 2);
});

test("exact historical revision lookup is supported", async () => {
  const response = await gateway().handle(
    request(
      "/v1/development/canonical-references/mem_gateway_001?revision=1",
    ),
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    envelope: { reference: { canonicalRevision: number; contentHash: string } };
  };
  assert.equal(body.envelope.reference.canonicalRevision, 1);
  assert.equal(body.envelope.reference.contentHash, "sha256-gateway-r1");
});

test("non-active canonical revision is delivered as status metadata, not filtered", async () => {
  const response = await gateway({
    revisions: {
      1: revision(1),
      2: revision(2, { status: "superseded" }),
    },
  }).handle(
    request(
      "/v1/development/canonical-references/mem_gateway_001?revision=2",
    ),
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    envelope: { reference: { status: string } };
  };
  assert.equal(body.envelope.reference.status, "superseded");
});

test("scope mismatch is hidden as not_found", async () => {
  const response = await gateway({
    headValue: head({ scope: OTHER_SCOPE }),
    revisions: { 2: revision(2, { scope: OTHER_SCOPE }) },
  }).handle(
    request(
      "/v1/development/canonical-references/mem_gateway_001?revision=2",
    ),
  );
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not_found" });
});

test("invalid memory ID and revision are rejected before canonical revision lookup", async () => {
  const counters = { heads: 0, revisions: 0 };
  const service = gateway({ counters });
  const badId = await service.handle(
    request("/v1/development/canonical-references/not-memory?revision=1"),
  );
  assert.equal(badId.status, 400);
  assert.deepEqual(counters, { heads: 0, revisions: 0 });

  const badRevision = await service.handle(
    request(
      "/v1/development/canonical-references/mem_gateway_001?revision=0",
    ),
  );
  assert.equal(badRevision.status, 400);
  assert.deepEqual(counters, { heads: 0, revisions: 0 });
});

test("missing exact revision is 404 while missing current head revision is canonical-state failure", async () => {
  const missingExact = await gateway({ revisions: { 2: revision(2) } }).handle(
    request(
      "/v1/development/canonical-references/mem_gateway_001?revision=1",
    ),
  );
  assert.equal(missingExact.status, 404);

  const missingCurrent = await gateway({ revisions: { 1: revision(1) } }).handle(
    request(
      "/v1/development/canonical-references/mem_gateway_001?revision=current",
    ),
  );
  assert.equal(missingCurrent.status, 500);
  assert.deepEqual(await missingCurrent.json(), {
    error: "canonical_state_incomplete",
  });
});

test("gateway exposes no search or list route", async () => {
  const response = await gateway().handle(
    request("/v1/development/canonical-references?query=navigation"),
  );
  assert.equal(response.status, 404);
});
