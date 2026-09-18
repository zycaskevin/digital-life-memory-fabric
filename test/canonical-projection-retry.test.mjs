import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isTransientHindsightProjectionError, withCanonicalProjectionRetry } from "../scripts/historical-migration/canonical-projection-retry.mjs";

const revision = () => ({
  memoryId: "mem_recovery_test", revision: 2,
  scope: { tenantId: "test-only", lifeDid: "did:test:nancy", memoryNamespace: "pilot.test" },
  canonicalContent: { text: "Synthetic test content; never real memory." },
});
const transient = () => Object.assign(new Error('retainBatch failed: "fetch failed"'), {
  name: "HindsightError", statusCode: undefined, details: "fetch failed",
});
function fixture(project, options = {}) {
  const waits = []; const events = [];
  const port = { project, search: async (...args) => ({ args }) };
  const wrapped = withCanonicalProjectionRetry(port, {
    maxAttempts: 3, wait: async ms => { waits.push(ms); }, onRetry: e => { events.push(e); }, ...options,
  });
  return { wrapped, waits, events, port };
}

test("projection transient retry pins the same revision and succeeds before returning", async () => {
  const input = revision(); const calls = [];
  const { wrapped, waits, events } = fixture(async r => {
    calls.push(r); if (calls.length === 1) throw transient(); return "materialized";
  });
  assert.equal(await wrapped.project(input), "materialized");
  assert.equal(calls.length, 2); assert.equal(calls[0], calls[1]);
  assert.notEqual(calls[0], input); assert.deepEqual(calls[0], input);
  assert.ok(Object.isFrozen(calls[0].canonicalContent));
  assert.deepEqual(waits, [1000]);
  assert.deepEqual(Object.keys(events[0]).sort(), ["attempt", "code", "delayMs", "nextAttempt"]);
  assert.ok(!JSON.stringify(events).includes(input.canonicalContent.text));
});

test("projection exhaustion is bounded and propagates the original error", async () => {
  const error = transient(); let calls = 0;
  const { wrapped, waits } = fixture(async () => { calls += 1; throw error; });
  await assert.rejects(wrapped.project(revision()), e => e === error);
  assert.equal(calls, 3); assert.deepEqual(waits, [1000, 2000]);
});

for (const statusCode of [400, 401, 403, 404, 409, 422, 501]) {
  test(`HTTP ${statusCode} fails closed without retry`, async () => {
    const error = Object.assign(transient(), { statusCode }); let calls = 0;
    const { wrapped, waits } = fixture(async () => { calls += 1; throw error; });
    await assert.rejects(wrapped.project(revision()), e => e === error);
    assert.equal(calls, 1); assert.deepEqual(waits, []);
  });
}
for (const statusCode of [408, 429, 500, 502, 503, 504]) {
  test(`transient HTTP ${statusCode} is eligible for bounded retry`, () => {
    assert.equal(isTransientHindsightProjectionError(Object.assign(transient(), { statusCode })), true);
  });
}
for (const error of [
  new Error("hindsight_canonical_projection_not_materialized"),
  new Error("canonical_projection_head_missing"),
  new Error("migration destination already has an active writer"),
  new TypeError("fetch failed"),
  Object.assign(transient(), { name: "AbortError" }),
  Object.assign(transient(), { details: "server rejected source" }),
  Object.assign(transient(), { statusCode: "503" }),
]) {
  test(`non-transport error remains terminal: ${error.name}/${error.message}/${error.statusCode ?? "none"}`, async () => {
    let calls = 0; const { wrapped, waits } = fixture(async () => { calls += 1; throw error; });
    await assert.rejects(wrapped.project(revision()), e => e === error);
    assert.equal(calls, 1); assert.deepEqual(waits, []);
  });
}

test("default wrapper does not retry or mutate existing projection behavior", async () => {
  let calls = 0; const input = revision(); const error = transient();
  const wrapped = withCanonicalProjectionRetry({
    project: async r => { assert.equal(r, input); calls += 1; throw error; }, search: async () => {},
  });
  await assert.rejects(wrapped.project(input), e => e === error); assert.equal(calls, 1);
});

test("search delegates with original arguments and this binding", async () => {
  const port = { project: async () => {}, search(...args) { assert.equal(this, port); return args; } };
  const wrapped = withCanonicalProjectionRetry(port); const q = {}; const opts = {};
  assert.deepEqual(await wrapped.search(q, opts), [q, opts]);
});

test("invalid retry options and unstable identities fail before side effects", async () => {
  const port = { project: async () => { throw new Error("must not call"); }, search: async () => {} };
  for (const maxAttempts of [0, 4, 1.5, NaN, Infinity]) assert.throws(() => withCanonicalProjectionRetry(port, { maxAttempts }));
  for (const baseDelayMs of [-1, 10001, 0.5, NaN]) assert.throws(() => withCanonicalProjectionRetry(port, { baseDelayMs }));
  const wrapped = withCanonicalProjectionRetry(port, { maxAttempts: 3 });
  for (const invalid of [undefined, { memoryId: "", revision: 1 }, { memoryId: "mem_valid", revision: 0 }]) {
    await assert.rejects(wrapped.project(invalid), /stable Canonical revision/);
  }
});

test("caller mutation during backoff cannot alter a replayed projection", async () => {
  const input = revision(); const seen = []; let calls = 0;
  const { wrapped } = fixture(async r => { seen.push(r.canonicalContent.text); calls += 1; if (calls === 1) throw transient(); }, {
    wait: async () => { input.canonicalContent.text = "caller changed during delay"; input.revision = 9; },
  });
  await wrapped.project(input); assert.equal(seen[0], seen[1]);
});

test("a retry never returns success while projection is still unresolved", async () => {
  let calls = 0; let release; let enteredRetry;
  const entered = new Promise(resolve => { enteredRetry = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const { wrapped } = fixture(async () => { calls += 1; if (calls === 1) throw transient(); enteredRetry(); await pending; });
  let settled = false; const result = wrapped.project(revision()).then(() => { settled = true; });
  await entered; assert.equal(settled, false); release(); await result; assert.equal(settled, true);
});

test("operational profile defaults are bounded without overriding explicit limits", () => {
  const profile = fileURLToPath(new URL("../scripts/historical-migration/direct-phase2-operational-profile.sh", import.meta.url));
  const command = 'source "$1"; printf "%s,%s,%s" "$DLMF_MIGRATION_MAX_UNITS" "$DLMF_MIGRATION_CONCURRENCY" "$DLMF_MIGRATION_PROJECTION_MAX_ATTEMPTS"';
  const read = env => execFileSync("/bin/bash", ["-c", command, "profile-test", profile], { env, encoding: "utf8" });
  assert.equal(read({ PATH: "/usr/bin:/bin" }), "32,4,3");
  assert.equal(read({ PATH: "/usr/bin:/bin", DLMF_MIGRATION_MAX_UNITS: "16", DLMF_MIGRATION_CONCURRENCY: "2", DLMF_MIGRATION_PROJECTION_MAX_ATTEMPTS: "1" }), "16,2,1");
});

test("retry is wired only to the migration projection, not the distillation client", () => {
  const source = readFileSync(new URL("../scripts/historical-migration/hermes-bounded-pilot.mjs", import.meta.url), "utf8");
  assert.match(source, /const retrievalPort = withCanonicalProjectionRetry\(/u);
  assert.match(source, /distillationProvider = new HindsightMemoryAdapter\(\{\s*client: clientPort,/u);
  const identity = source.slice(source.indexOf("function migrationId("), source.indexOf("async function privateJson("));
  assert.ok(!identity.includes("projectionMaxAttempts")); assert.ok(!identity.includes("migrationConcurrency"));
});
