import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  resolveHindsightApiKey,
  serviceUrl,
} from "../scripts/multi-source-dlmf-runtime.mjs";
import {
  assertSecureSourceDirectory,
} from "../scripts/multi-source-worker-common.mjs";
import {
  processLockIdentity,
} from "../scripts/multi-source-worker-common.mjs";

const repo = resolve(new URL("..", import.meta.url).pathname);
const node = process.execPath;

function run(script, args, env) {
  return spawnSync(node, [resolve(repo, script), ...args], {
    cwd: repo,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
}

function codexRecords(id, userText) {
  return [
    {
      ordinal: 0,
      timestamp: "2026-10-01T12:00:00.000Z",
      type: "session_meta",
      payload: {
        id,
        session_id: "shared-session",
        timestamp: "2026-10-01T12:00:00.000Z",
        source: "cli",
      },
    },
    {
      ordinal: 1,
      timestamp: "2026-10-01T12:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: userText }],
      },
    },
    {
      ordinal: 2,
      timestamp: "2026-10-01T12:00:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Acknowledged." }],
      },
    },
  ];
}

async function writeJsonl(path, records) {
  await writeFile(
    path,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
}

function chatSnapshot(text, revision = "r1", updatedAt = "2026-10-01T12:01:00.000Z") {
  return {
    contract: "dlmf/chatgpt-captured-conversation/v1",
    conversationId: "chat-activation-001",
    revision,
    status: "completed",
    startedAt: "2026-10-01T12:00:00.000Z",
    updatedAt,
    messages: [
      {
        id: "u1",
        role: "user",
        text,
        createdAt: "2026-10-01T12:00:30.000Z",
      },
      {
        id: "a1",
        role: "assistant",
        text: "Acknowledged.",
        createdAt: "2026-10-01T12:00:40.000Z",
      },
    ],
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dlmf-activation-"));
  await chmod(root, 0o700);
  const codexRoot = join(root, "codex");
  const chatRoot = join(root, "chatgpt");
  const stateRoot = join(root, "state");
  await Promise.all([
    mkdir(codexRoot, { mode: 0o700 }),
    mkdir(chatRoot, { mode: 0o700 }),
    mkdir(stateRoot, { mode: 0o700 }),
  ]);
  return { root, codexRoot, chatRoot, stateRoot };
}

function activationEnv(paths) {
  return {
    DLMF_CODEX_SESSIONS_ROOT: paths.codexRoot,
    DLMF_CODEX_INCREMENTAL_CHECKPOINT: join(paths.stateRoot, "codex.json"),
    DLMF_CODEX_DEVELOPMENT_EXPERIENCE_JOURNAL: join(paths.stateRoot, "codex-refs.jsonl"),
    DLMF_CODEX_TENANT_ID: "tenant-arthur",
    DLMF_CODEX_LIFE_DID: "did:arthurverse:nancy",
    DLMF_CODEX_MEMORY_NAMESPACE: "life",
    DLMF_CODEX_MINIMUM_IDLE_MS: "0",
    DLMF_CODEX_PAGE_SIZE: "10",

    DLMF_CHATGPT_CAPTURE_ROOT: paths.chatRoot,
    DLMF_CHATGPT_INCREMENTAL_CHECKPOINT: join(paths.stateRoot, "chatgpt.json"),
    DLMF_CHATGPT_DEVELOPMENT_EXPERIENCE_JOURNAL: join(paths.stateRoot, "chatgpt-refs.jsonl"),
    DLMF_CHATGPT_TENANT_ID: "tenant-arthur",
    DLMF_CHATGPT_LIFE_DID: "did:arthurverse:nancy",
    DLMF_CHATGPT_MEMORY_NAMESPACE: "life",
    DLMF_CHATGPT_PAGE_SIZE: "10",

    DLMF_MULTI_SOURCE_WRITE_MODE: "reference_only",
  };
}

test("multi-source worker preflight is read-only and reference_only needs no DB/provider config", async () => {
  const paths = await fixture();
  try {
    await writeJsonl(
      join(paths.codexRoot, "session-a.jsonl"),
      codexRecords("journal-a", "Owner-authored durable preference."),
    );
    await writeFile(
      join(paths.chatRoot, "chat.json"),
      `${JSON.stringify(chatSnapshot("Owner-authored ChatGPT note."))}\n`,
      "utf8",
    );
    const env = activationEnv(paths);

    const codex = run(
      "scripts/codex-incremental-sync-worker.mjs",
      ["--preflight", "--reference-only"],
      env,
    );
    assert.equal(codex.status, 0, codex.stderr);
    assert.match(codex.stdout, /DLMF_CODEX_PREFLIGHT=PASS/);
    assert.match(codex.stdout, /checkpointWrites=0 canonicalMemoryWrites=0/);

    const chatgpt = run(
      "scripts/chatgpt-capture-sync-worker.mjs",
      ["--preflight", "--reference-only"],
      env,
    );
    assert.equal(chatgpt.status, 0, chatgpt.stderr);
    assert.match(chatgpt.stdout, /DLMF_CHATGPT_PREFLIGHT=PASS/);

    await assert.rejects(() => stat(env.DLMF_CODEX_INCREMENTAL_CHECKPOINT));
    await assert.rejects(() => stat(env.DLMF_CHATGPT_INCREMENTAL_CHECKPOINT));
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("Codex and ChatGPT workers baseline then process only source deltas in reference_only mode", async () => {
  const paths = await fixture();
  try {
    const env = activationEnv(paths);
    await writeJsonl(
      join(paths.codexRoot, "session-a.jsonl"),
      codexRecords("journal-a", "Initial Codex preference."),
    );
    await writeFile(
      join(paths.chatRoot, "chat.json"),
      `${JSON.stringify(chatSnapshot("Initial ChatGPT preference."))}\n`,
      "utf8",
    );

    for (const script of [
      "scripts/codex-incremental-sync-worker.mjs",
      "scripts/chatgpt-capture-sync-worker.mjs",
    ]) {
      const result = run(script, ["--baseline-current", "--reference-only"], env);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /mode=reference_only/);
      assert.match(result.stdout, /ingested=0/);
    }

    await writeJsonl(
      join(paths.codexRoot, "session-b.jsonl"),
      codexRecords("journal-b", "New Codex delta preference."),
    );
    await writeFile(
      join(paths.chatRoot, "chat.json"),
      `${JSON.stringify(chatSnapshot(
        "Changed ChatGPT delta preference.",
        "r2",
        "2026-10-01T12:02:00.000Z",
      ))}\n`,
      "utf8",
    );

    const codexDelta = run(
      "scripts/codex-incremental-sync-worker.mjs",
      ["--reference-only"],
      env,
    );
    assert.equal(codexDelta.status, 0, codexDelta.stderr);
    assert.match(codexDelta.stdout, /changed=1/);
    assert.match(codexDelta.stdout, /ingested=0/);
    assert.match(codexDelta.stdout, /developmentRefs=1/);

    const chatDelta = run(
      "scripts/chatgpt-capture-sync-worker.mjs",
      ["--reference-only"],
      env,
    );
    assert.equal(chatDelta.status, 0, chatDelta.stderr);
    assert.match(chatDelta.stdout, /changed=1/);
    assert.match(chatDelta.stdout, /ingested=0/);

    for (const path of [
      env.DLMF_CODEX_DEVELOPMENT_EXPERIENCE_JOURNAL,
      env.DLMF_CHATGPT_DEVELOPMENT_EXPERIENCE_JOURNAL,
    ]) {
      const text = await readFile(path, "utf8");
      assert.match(text, /"disposition":"REFERENCE_ONLY"/);
      assert.equal(text.includes("New Codex delta preference."), false);
      assert.equal(text.includes("Changed ChatGPT delta preference."), false);
    }

    const nightly = run("scripts/multi-source-nightly-consolidation.mjs", [], env);
    assert.equal(nightly.status, 0, nightly.stderr);
    assert.match(nightly.stdout, /DLMF_MULTI_SOURCE_NIGHTLY=PASS/);
    assert.match(nightly.stdout, /historicalFullImport=0/);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("distill mode is explicit and fails closed without DLMF writer configuration", async () => {
  const paths = await fixture();
  try {
    await writeJsonl(
      join(paths.codexRoot, "session-a.jsonl"),
      codexRecords("journal-a", "Distill must not silently start."),
    );
    const env = {
      ...activationEnv(paths),
      DLMF_MULTI_SOURCE_WRITE_MODE: "distill",
      DLMF_MULTI_SOURCE_DISTILL_CANARY: "1",
      DLMF_MULTI_SOURCE_CANARY_NAMESPACE: "canary-multi-source-test",
      DLMF_CODEX_MEMORY_NAMESPACE: "canary-multi-source-test",
      DLMF_DLS_DATABASE_URL: "",
    };
    const result = run(
      "scripts/codex-incremental-sync-worker.mjs",
      ["--preflight"],
      env,
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DLMF_DLS_DATABASE_URL is required/);
    await assert.rejects(() => stat(env.DLMF_CODEX_INCREMENTAL_CHECKPOINT));
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});


test("worker lock prevents periodic/nightly overlap without advancing checkpoints", async () => {
  const paths = await fixture();
  try {
    const env = activationEnv(paths);
    await writeJsonl(
      join(paths.codexRoot, "session-a.jsonl"),
      codexRecords("journal-a", "Lock-test preference."),
    );
    await writeFile(
      join(paths.chatRoot, "chat.json"),
      `${JSON.stringify(chatSnapshot("Lock-test ChatGPT preference."))}\n`,
      "utf8",
    );

    const codexLock = `${env.DLMF_CODEX_INCREMENTAL_CHECKPOINT}.worker.lock`;
    const chatLock = `${env.DLMF_CHATGPT_INCREMENTAL_CHECKPOINT}.worker.lock`;
    const activeLock = JSON.stringify({
      ...(await processLockIdentity()),
      createdAt: new Date().toISOString(),
    }) + "\n";
    await writeFile(codexLock, activeLock, { mode: 0o600 });
    const busyCodex = run(
      "scripts/codex-incremental-sync-worker.mjs",
      ["--reference-only"],
      env,
    );
    assert.equal(busyCodex.status, 75, busyCodex.stderr);
    assert.match(busyCodex.stdout, /DLMF_CODEX_INCREMENTAL=BUSY/);
    await assert.rejects(() => stat(env.DLMF_CODEX_INCREMENTAL_CHECKPOINT));

    await writeFile(chatLock, activeLock, { mode: 0o600 });
    const nightly = run("scripts/multi-source-nightly-consolidation.mjs", [], env);
    assert.equal(nightly.status, 75, nightly.stderr);
    assert.match(nightly.stdout, /DLMF_MULTI_SOURCE_NIGHTLY=DEFERRED/);
    assert.match(nightly.stdout, /busy=2/);
    await assert.rejects(() => stat(env.DLMF_CHATGPT_INCREMENTAL_CHECKPOINT));
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("reference journal failure happens before source checkpoint advancement", async () => {
  const paths = await fixture();
  try {
    const env = activationEnv(paths);
    await writeJsonl(
      join(paths.codexRoot, "session-a.jsonl"),
      codexRecords("journal-a", "Reference durability preference."),
    );
    const badJournal = join(paths.stateRoot, "journal-is-directory");
    await mkdir(badJournal, { mode: 0o700 });
    env.DLMF_CODEX_DEVELOPMENT_EXPERIENCE_JOURNAL = badJournal;

    const failed = run(
      "scripts/codex-incremental-sync-worker.mjs",
      ["--reference-only"],
      env,
    );
    assert.notEqual(failed.status, 0);
    await assert.rejects(() => stat(env.DLMF_CODEX_INCREMENTAL_CHECKPOINT));

    env.DLMF_CODEX_DEVELOPMENT_EXPERIENCE_JOURNAL =
      join(paths.stateRoot, "codex-retry-refs.jsonl");
    const retry = run(
      "scripts/codex-incremental-sync-worker.mjs",
      ["--reference-only"],
      env,
    );
    assert.equal(retry.status, 0, retry.stderr);
    assert.match(retry.stdout, /changed=1/);
    assert.match(retry.stdout, /developmentRefs=1/);
    assert.equal((await stat(env.DLMF_CODEX_INCREMENTAL_CHECKPOINT)).isFile(), true);
    const journalText = await readFile(
      env.DLMF_CODEX_DEVELOPMENT_EXPERIENCE_JOURNAL,
      "utf8",
    );
    assert.match(journalText, /"disposition":"REFERENCE_ONLY"/);
    const journalLines = journalText.trim().split(/\r?\n/u);
    assert.ok(journalLines.length >= 1);
    for (const line of journalLines) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});


test("distill mode cannot target the production life namespace without an explicit canary scope", async () => {
  const paths = await fixture();
  try {
    const env = {
      ...activationEnv(paths),
      DLMF_MULTI_SOURCE_WRITE_MODE: "distill",
      DLMF_MULTI_SOURCE_DISTILL_CANARY: "1",
      DLMF_MULTI_SOURCE_CANARY_NAMESPACE: "canary-multi-source-test",
      DLMF_CODEX_MEMORY_NAMESPACE: "life",
    };
    const result = run(
      "scripts/codex-incremental-sync-worker.mjs",
      ["--preflight"],
      env,
    );
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /distill scope must match DLMF_MULTI_SOURCE_CANARY_NAMESPACE/,
    );
    await assert.rejects(() => stat(env.DLMF_CODEX_INCREMENTAL_CHECKPOINT));
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("reference-only mode requires a durable Development reference journal", async () => {
  const paths = await fixture();
  try {
    const env = activationEnv(paths);
    delete env.DLMF_CODEX_DEVELOPMENT_EXPERIENCE_JOURNAL;
    const result = run(
      "scripts/codex-incremental-sync-worker.mjs",
      ["--preflight", "--reference-only"],
      env,
    );
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /DLMF_CODEX_DEVELOPMENT_EXPERIENCE_JOURNAL is required/,
    );
    await assert.rejects(() => stat(env.DLMF_CODEX_INCREMENTAL_CHECKPOINT));
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("stale worker locks fail loudly instead of looking like healthy contention", async () => {
  const paths = await fixture();
  try {
    const env = activationEnv(paths);
    await writeJsonl(
      join(paths.codexRoot, "session-a.jsonl"),
      codexRecords("journal-a", "Stale-lock preference."),
    );
    const codexLock = `${env.DLMF_CODEX_INCREMENTAL_CHECKPOINT}.worker.lock`;
    await writeFile(
      codexLock,
      JSON.stringify({
        pid: 2147483647,
        createdAt: "2026-10-01T00:00:00.000Z",
      }) + "\n",
      { mode: 0o600 },
    );

    const result = run(
      "scripts/codex-incremental-sync-worker.mjs",
      ["--reference-only"],
      env,
    );
    assert.notEqual(result.status, 0);
    assert.notEqual(result.status, 75);
    assert.match(result.stderr, /stale and requires operator review/);

    const nightly = run(
      "scripts/multi-source-nightly-consolidation.mjs",
      [],
      env,
    );
    assert.notEqual(nightly.status, 0);
    assert.match(nightly.stderr, /DLMF_MULTI_SOURCE_NIGHTLY=FAIL/);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("source root accepts only owner-private-group write and rejects world write", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlmf-source-permissions-"));
  try {
    await chmod(root, 0o775);
    assert.equal(await assertSecureSourceDirectory(root), root);

    await chmod(root, 0o777);
    await assert.rejects(
      () => assertSecureSourceDirectory(root),
      /must not be world-writable/,
    );
  } finally {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("multi-source runtime uses only explicit Hindsight credentials and accepts IPv6 loopback", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlmf-activation-hindsight-key-"));
  const priorKey = process.env.DLMF_DLS_HINDSIGHT_API_KEY;
  const priorHermesHome = process.env.HERMES_HOME;
  try {
    await writeFile(
      join(root, ".env"),
      "HINDSIGHT_API_KEY=must-not-be-inherited\\n",
      "utf8",
    );
    process.env.HERMES_HOME = root;
    delete process.env.DLMF_DLS_HINDSIGHT_API_KEY;
    assert.equal(resolveHindsightApiKey(), undefined);
    assert.equal(serviceUrl("http://[::1]:18888"), "http://[::1]:18888");
  } finally {
    if (priorKey === undefined) delete process.env.DLMF_DLS_HINDSIGHT_API_KEY;
    else process.env.DLMF_DLS_HINDSIGHT_API_KEY = priorKey;
    if (priorHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = priorHermesHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("activation scripts parse and user-systemd templates keep hardened reference-only defaults", async () => {
  for (const script of [
    "scripts/multi-source-dlmf-runtime.mjs",
    "scripts/multi-source-worker-common.mjs",
    "scripts/codex-incremental-sync-worker.mjs",
    "scripts/chatgpt-capture-sync-worker.mjs",
    "scripts/chatgpt-capture-inbox-server.mjs",
    "scripts/multi-source-nightly-consolidation.mjs",
  ]) {
    const check = spawnSync(node, ["--check", resolve(repo, script)], {
      encoding: "utf8",
    });
    assert.equal(check.status, 0, `${script}: ${check.stderr}`);
  }

  const deployRoot = resolve(repo, "deploy/gb10/multi-source");
  const envExample = await readFile(join(deployRoot, "multi-source.env.example"), "utf8");
  assert.match(envExample, /^DLMF_MULTI_SOURCE_WRITE_MODE=reference_only$/m);
  assert.equal(envExample.includes("DLMF_MULTI_SOURCE_WRITE_MODE=distill"), false);

  const inboxEnv = await readFile(
    join(deployRoot, "chatgpt-capture-inbox.env.example"),
    "utf8",
  );
  assert.equal(inboxEnv.includes("DLMF_DLS_DATABASE_URL"), false);
  assert.equal(inboxEnv.includes("DLMF_DLS_HINDSIGHT"), false);
  assert.equal(inboxEnv.includes("DLMF_MULTI_SOURCE_WRITE_MODE"), false);

  const inboxUnit = await readFile(
    join(deployRoot, "nancy-chatgpt-capture-inbox.service.in"),
    "utf8",
  );
  assert.match(inboxUnit, /EnvironmentFile=REPLACE_WITH_CHATGPT_INBOX_ENV/);
  assert.match(inboxUnit, /ReadWritePaths=REPLACE_WITH_CHATGPT_CAPTURE_ROOT/);
  assert.equal(inboxUnit.includes("REPLACE_WITH_MULTI_SOURCE_ENV"), false);
  assert.equal(inboxUnit.includes("REPLACE_WITH_MEMORY_RUNTIME"), false);

  for (const name of [
    "nancy-codex-memory-sync.service.in",
    "nancy-chatgpt-memory-sync.service.in",
    "nancy-multi-source-nightly.service.in",
  ]) {
    const unit = await readFile(join(deployRoot, name), "utf8");
    assert.match(unit, /NoNewPrivileges=true/);
    assert.match(unit, /ProtectSystem=strict/);
    assert.match(unit, /ProtectHome=read-only/);
    assert.match(unit, /UMask=0077/);
    assert.equal(/^User=/m.test(unit), false);
    assert.equal(/(sk-|Bearer\s+[A-Za-z0-9_-]{20,})/.test(unit), false);
  }

  assert.match(inboxUnit, /ProtectHome=tmpfs/);
  assert.match(inboxUnit, /BindReadOnlyPaths=REPLACE_WITH_DLMF_REPO/);
  assert.match(inboxUnit, /BindReadOnlyPaths=REPLACE_WITH_CHATGPT_INBOX_TOKEN_FILE/);
  assert.match(inboxUnit, /BindPaths=REPLACE_WITH_CHATGPT_CAPTURE_ROOT/);
  assert.match(
    inboxUnit,
    /UnsetEnvironment=.*DLMF_DLS_DATABASE_URL.*DLMF_DLS_HINDSIGHT_API_KEY.*DLMF_DLS_BEARER_TOKEN.*DLMF_MULTI_SOURCE_WRITE_MODE/,
  );

  for (const name of [
    "nancy-codex-memory-sync.service.in",
    "nancy-chatgpt-memory-sync.service.in",
    "nancy-multi-source-nightly.service.in",
  ]) {
    const unit = await readFile(join(deployRoot, name), "utf8");
    assert.match(unit, /SuccessExitStatus=75/);
  }
});
