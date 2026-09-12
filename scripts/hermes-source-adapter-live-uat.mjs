#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  HermesSourceAdapter,
  HermesSqliteReader,
  assertNormalizedExperience,
} from "../dist/index.js";

const CONTRACT = "dlmf/hermes-source-adapter-live-uat/v1";

function usage() {
  console.log(`Usage: node scripts/hermes-source-adapter-live-uat.mjs --db <sqlite-path> [options]\n\nOptions:\n  --limit <n>                 Discovery page size (default 25, max 1000)\n  --max-pages <n>             Maximum metadata pages to scan (default 20)\n  --max-sample-messages <n>   Maximum messages in the sampled session (default 200)\n  --receipt <path>            Write a content-free JSON receipt (0600)\n  --help                      Show this help\n\nThe UAT opens Hermes SQLite read-only and never prints message bodies, titles, chat IDs, user IDs, or raw source IDs.`);
}

function parsePositiveInt(value, name, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    limit: 25,
    maxPages: 20,
    maxSampleMessages: 200,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help") return { ...options, help: true };
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--db") options.db = next();
    else if (arg === "--limit") options.limit = parsePositiveInt(next(), "--limit", 1000);
    else if (arg === "--max-pages") options.maxPages = parsePositiveInt(next(), "--max-pages", 1000);
    else if (arg === "--max-sample-messages") options.maxSampleMessages = parsePositiveInt(next(), "--max-sample-messages", 1000000);
    else if (arg === "--receipt") options.receipt = next();
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function numericMetadata(unit, key) {
  const value = Number(unit.metadata?.[key] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function sourceIdHashes(units) {
  return units.map((unit) => sha256(unit.source.sourceId));
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  if (!options.db) throw new Error("--db is required");

  const dbPath = resolve(options.db);
  const databaseStat = await stat(dbPath);
  if (!databaseStat.isFile()) throw new Error("--db must point to a regular file");

  const adapter = new HermesSourceAdapter({
    reader: new HermesSqliteReader(dbPath),
  });
  const inspection = await adapter.inspect();
  if (inspection.sourceSystem !== "hermes" || inspection.sourceType !== "conversation_session") {
    throw new Error("unexpected Hermes adapter source identity");
  }

  const firstPage = await adapter.discover({ limit: options.limit });
  const candidates = [];
  let pagesScanned = 0;
  let unitsScanned = 0;
  let page = firstPage;
  let cursor;

  while (pagesScanned < options.maxPages) {
    pagesScanned += 1;
    unitsScanned += page.units.length;
    for (const unit of page.units) {
      const messageCount = numericMetadata(unit, "messageCount");
      if (unit.metadata?.hidden === true || messageCount < 1 || messageCount > options.maxSampleMessages) continue;
      candidates.push(unit);
    }
    if (page.nextCursor === undefined || page.units.length === 0) break;
    cursor = page.nextCursor;
    page = await adapter.discover({ limit: options.limit, cursor });
  }

  if (candidates.length === 0) {
    throw new Error("no bounded non-hidden Hermes session was found within the metadata scan window");
  }

  candidates.sort((a, b) => {
    const aTools = numericMetadata(a, "toolCallCount") > 0 ? 0 : 1;
    const bTools = numericMetadata(b, "toolCallCount") > 0 ? 0 : 1;
    return aTools - bTools || numericMetadata(a, "messageCount") - numericMetadata(b, "messageCount");
  });
  const sample = candidates[0];

  const firstRead = await adapter.read(sample);
  const firstFingerprint = await adapter.fingerprint(sample);
  const firstNormalized = await adapter.normalize(firstRead);
  assertNormalizedExperience(firstNormalized);

  const secondRead = await adapter.read(sample);
  const secondFingerprint = await adapter.fingerprint(sample);
  const secondNormalized = await adapter.normalize(secondRead);
  assertNormalizedExperience(secondNormalized);

  const repeatReadStable =
    firstNormalized.experienceId === secondNormalized.experienceId
    && firstFingerprint.value === secondFingerprint.value
    && firstNormalized.provenance.sourceFingerprint.value === secondNormalized.provenance.sourceFingerprint.value;
  if (!repeatReadStable) throw new Error("repeat-read identity/fingerprint stability failed");

  const sourceMessageCount = firstRead.payload.messages.length;
  if (firstNormalized.events.length !== sourceMessageCount) {
    throw new Error("normalized event count does not match source message count");
  }

  let checkpointResume = {
    applicable: false,
    samePageAsDirectCursor: true,
    overlapsPreviousPage: false,
    resumedUnitCount: 0,
  };
  if (firstPage.nextCursor !== undefined) {
    const checkpoint = {
      adapterName: adapter.name,
      adapterVersion: adapter.version,
      sourceSystem: "hermes",
      sourceType: "conversation_session",
      cursor: firstPage.nextCursor,
      updatedAt: new Date().toISOString(),
    };
    const checkpointPage = await adapter.discover({ limit: options.limit, checkpoint });
    const directPage = await adapter.discover({ limit: options.limit, cursor: firstPage.nextCursor });
    const checkpointIds = sourceIdHashes(checkpointPage.units);
    const directIds = sourceIdHashes(directPage.units);
    const previousIds = new Set(sourceIdHashes(firstPage.units));
    checkpointResume = {
      applicable: true,
      samePageAsDirectCursor: arraysEqual(checkpointIds, directIds),
      overlapsPreviousPage: checkpointIds.some((id) => previousIds.has(id)),
      resumedUnitCount: checkpointPage.units.length,
    };
    if (!checkpointResume.samePageAsDirectCursor || checkpointResume.overlapsPreviousPage) {
      throw new Error("checkpoint resume equivalence/non-overlap validation failed");
    }
  }

  const actorKinds = [...new Set(firstNormalized.actors.map((actor) => actor.kind))].sort();
  const eventTypes = Object.fromEntries(
    [...new Set(firstNormalized.events.map((event) => event.eventType))]
      .sort()
      .map((eventType) => [
        eventType,
        firstNormalized.events.filter((event) => event.eventType === eventType).length,
      ]),
  );

  const receipt = {
    contract: CONTRACT,
    status: "PASS",
    observedAt: new Date().toISOString(),
    adapter: {
      name: adapter.name,
      version: adapter.version,
      sourceSystem: inspection.sourceSystem,
      sourceType: inspection.sourceType,
      capabilities: inspection.capabilities,
    },
    source: {
      databaseBytes: databaseStat.size,
      schemaVersion: inspection.metadata.schemaVersion ?? null,
      sessionCount: inspection.metadata.sessionCount ?? null,
      messageCount: inspection.metadata.messageCount ?? null,
    },
    discovery: {
      pageLimit: options.limit,
      maxPages: options.maxPages,
      pagesScanned,
      unitsScanned,
      checkpointResume,
    },
    sample: {
      sourceIdSha256: sha256(sample.source.sourceId),
      experienceId: firstNormalized.experienceId,
      sourceFingerprint: firstFingerprint.value,
      sourceMessageCount,
      normalizedEventCount: firstNormalized.events.length,
      normalizedContentCount: firstNormalized.content.length,
      sourceToolCallCount: numericMetadata(sample, "toolCallCount"),
      actorKinds,
      eventTypes,
      repeatReadStable,
    },
    privacy: {
      databaseOpenedReadOnly: true,
      rawSourceIdPrinted: false,
      messageBodiesPrinted: false,
      titlesPrinted: false,
      chatOrUserIdsPrinted: false,
    },
  };

  if (options.receipt) {
    const receiptPath = resolve(options.receipt);
    await mkdir(dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    await chmod(receiptPath, 0o600);
  }

  console.log("HERMES_SOURCE_ADAPTER_LIVE_UAT=PASS");
  console.log(JSON.stringify(receipt));
}

main().catch((error) => {
  console.error(`HERMES_SOURCE_ADAPTER_LIVE_UAT=FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
