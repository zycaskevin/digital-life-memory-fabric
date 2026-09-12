import assert from "node:assert/strict";
import test from "node:test";
import {
  HermesSourceAdapter,
  assertNormalizedExperience,
  type HermesSessionPayload,
  type HermesSessionRow,
  type HermesStateReader,
} from "../src/index.js";

const session: HermesSessionRow = {
  id: "20260912_210000_demo",
  source: "cli",
  profileName: "nancy",
  title: "Adapter test",
  messageCount: 3,
  toolCallCount: 1,
  startedAt: 1_757_687_200,
  endedAt: 1_757_687_260,
  lastActivityAt: 1_757_687_260,
  endReason: "completed",
  archived: false,
  expiryFinalized: false,
  hidden: false,
};

const payload: HermesSessionPayload = {
  session,
  messages: [
    {
      id: 10,
      sessionId: session.id,
      role: "user",
      content: "Remember that I prefer source-neutral memory migration.",
      timestamp: 1_757_687_201,
      compressedSummary: false,
      active: true,
      compacted: false,
    },
    {
      id: 11,
      sessionId: session.id,
      role: "assistant",
      content: "I will inspect the source first.",
      toolCalls: '[{"name":"inspect"}]',
      timestamp: 1_757_687_202,
      compressedSummary: false,
      active: true,
      compacted: false,
    },
    {
      id: 12,
      sessionId: session.id,
      role: "tool",
      content: "schema ok",
      toolCallId: "call_1",
      toolName: "inspect",
      timestamp: 1_757_687_203,
      compressedSummary: false,
      active: true,
      compacted: false,
    },
  ],
};

class FakeHermesReader implements HermesStateReader {
  listCalls: Array<{ afterSessionId?: string; limit: number }> = [];
  readCalls: string[] = [];

  async inspect() {
    return { schemaVersion: "42", tables: ["sessions", "messages"], sessionCount: 11216, messageCount: 997238 };
  }

  async listSessions(request: { afterSessionId?: string; limit: number }) {
    this.listCalls.push(request);
    return request.afterSessionId === undefined ? [structuredClone(session)] : [];
  }

  async readSession(sessionId: string) {
    this.readCalls.push(sessionId);
    assert.equal(sessionId, session.id);
    return structuredClone(payload);
  }
}

const fixedClock = () => new Date("2026-09-12T13:10:00.000Z");

test("ADAPTER-001 inspect exposes Hermes capabilities without leaking schema into DLMF Core", async () => {
  const adapter = new HermesSourceAdapter({ reader: new FakeHermesReader(), version: "test", clock: fixedClock });
  const inspection = await adapter.inspect();
  assert.equal(inspection.sourceSystem, "hermes");
  assert.equal(inspection.sourceType, "conversation_session");
  assert.equal(inspection.capabilities.historicalImport, "full");
  assert.equal(inspection.capabilities.toolEvents, "full");
  assert.equal(inspection.capabilities.deletionDetection, "unknown");
  assert.equal(inspection.metadata.sessionCount, 11216);
});

test("ADAPTER-001 discover is bounded, cursor-based, and uses stable DLMF experience identity", async () => {
  const reader = new FakeHermesReader();
  const adapter = new HermesSourceAdapter({ reader, clock: fixedClock });
  const page = await adapter.discover({ limit: 1 });
  assert.equal(page.units.length, 1);
  assert.equal(page.nextCursor, session.id);
  assert.match(page.units[0]!.experienceId, /^exp_[0-9a-f]{64}$/);
  assert.equal(page.units[0]!.source.sourceId, session.id);
  assert.equal(page.units[0]!.startedAt.certainty, "exact");
  assert.equal(page.units[0]!.endedAt.certainty, "exact");
  await adapter.discover({ limit: 1, cursor: page.nextCursor });
  assert.equal(reader.listCalls[1]?.afterSessionId, session.id);
});

test("ADAPTER-001 read/fingerprint/normalize preserves messages, tool evidence, provenance, and idempotent identity", async () => {
  const reader = new FakeHermesReader();
  const adapter = new HermesSourceAdapter({ reader, version: "0.1-test", clock: fixedClock });
  const [unit] = (await adapter.discover({ limit: 10 })).units;
  assert.ok(unit);
  const result = await adapter.read(unit);
  const fp1 = await adapter.fingerprint(unit);
  const fp2 = await adapter.fingerprint(unit);
  assert.deepEqual(fp1, fp2);

  const normalized = await adapter.normalize(result);
  assertNormalizedExperience(normalized);
  assert.equal(normalized.experienceId, unit.experienceId);
  assert.equal(normalized.events.length, 3);
  assert.equal(normalized.events[1]?.eventType, "tool_or_message");
  assert.equal(normalized.events[2]?.metadata?.toolName, "inspect");
  assert.equal(normalized.provenance.sourceFingerprint.value, fp1.value);
  assert.equal(normalized.provenance.adapterName, "HermesSourceAdapter");
  assert.equal(normalized.provenance.sourceLocator, `hermes:session:${session.id}`);
  assert.deepEqual(normalized.actors.map((x) => x.kind).sort(), ["assistant", "tool", "user"]);
});

test("ADAPTER-001 rejects foreign units and unbounded discovery", async () => {
  const adapter = new HermesSourceAdapter({ reader: new FakeHermesReader(), clock: fixedClock });
  await assert.rejects(() => adapter.discover({ limit: 1001 }), /between 1 and 1000/);
  const foreign = (await adapter.discover({ limit: 1 })).units[0]!;
  const mutated = structuredClone(foreign);
  mutated.source.sourceSystem = "openclaw";
  await assert.rejects(() => adapter.read(mutated), /does not belong/);
});
