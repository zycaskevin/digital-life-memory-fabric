import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import {
  EvidenceBoundMemoryGovernance,
  FilesystemRawExperienceArchiveProvider,
  HindsightMemoryAdapter,
  PostgresCanonicalMemoryStore,
  PostgresDistillationReceiptStore,
  PreservationCompleteRetentionPolicy,
  PruneEligibilityService,
  ReflectiveMemoryService,
  TranscriptDistillationService,
} from "../../dist/index.js";

const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");
const PREFLIGHT = args.has("--preflight");
const PLAN_ONLY = !APPLY && !PREFLIGHT;
const now = new Date();
const runStamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
const runId = `pilot_${runStamp}`;

const home = process.env.HOME || homedir();
const pilotEnvFile = resolve(
  process.env.DLMF_PILOT_ENV_FILE || join(home, ".config", "dlmf", "production-pilot.env"),
);
const hermesHome = resolve(process.env.HERMES_HOME || join(home, ".hermes"));
const hermesDb = resolve(process.env.DLMF_PILOT_HERMES_DB || join(hermesHome, "state.db"));
const reportRoot = resolve(
  process.env.DLMF_PILOT_REPORT_ROOT || join(home, ".local", "state", "dlmf", "production-pilot"),
);
const archiveRoot = resolve(
  process.env.DLMF_PILOT_ARCHIVE_ROOT || join(home, ".local", "share", "dlmf", "production-pilot", runId, "raw"),
);
const manifestPath = resolve(
  process.env.DLMF_PILOT_MANIFEST || join(reportRoot, `${runId}-manifest.json`),
);
const planManifestPath = process.env.DLMF_PILOT_PLAN_MANIFEST
  ? resolve(process.env.DLMF_PILOT_PLAN_MANIFEST)
  : undefined;
const reportPath = resolve(
  process.env.DLMF_PILOT_REPORT || join(reportRoot, `${runId}-report.json`),
);
const namespace = process.env.DLMF_PILOT_NAMESPACE || "pilot.memory-distillation.v0.1.1";
const lifeDid = process.env.DLMF_PILOT_LIFE_DID || "did:arthurverse:nancy";
const tenantId = process.env.DLMF_PILOT_TENANT_ID || "arthurverse-production-pilot";
const schema = process.env.DLMF_PILOT_SCHEMA || `dlmf_pilot_v011_${runStamp.toLowerCase()}`;
const distillationBank =
  process.env.DLMF_PILOT_HINDSIGHT_DISTILLATION_BANK || "nancy-dlmf-pilot-distillation-v011";
const projectionBank =
  process.env.DLMF_PILOT_HINDSIGHT_PROJECTION_BANK || "nancy-dlmf-pilot-canonical-v011";
const candidateLimit = clampInt(process.env.DLMF_PILOT_SESSION_SCAN_LIMIT, 500, 50, 2000);
const maxTranscriptChars = clampInt(
  process.env.DLMF_PILOT_MAX_TRANSCRIPT_CHARS,
  240_000,
  20_000,
  1_000_000,
);

const CATEGORIES = [
  "ordinary_conversation",
  "technical_debugging",
  "long_project_conversation",
  "preference_change",
  "inferred_insight",
];

function readPersistedPilotDatabaseUrl() {
  if (!existsSync(pilotEnvFile)) return undefined;
  const text = readFileSync(pilotEnvFile, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length);
    const index = line.indexOf("=");
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    if (key !== "DLMF_PILOT_DATABASE_URL") continue;
    let value = line.slice(index + 1).trim();
    if (value.length >= 2 && value[0] === value.at(-1) && ["'", '"'].includes(value[0])) {
      value = value.slice(1, -1);
    }
    return value || undefined;
  }
  return undefined;
}

function pilotDatabaseUrl() {
  return process.env.DLMF_PILOT_DATABASE_URL || readPersistedPilotDatabaseUrl();
}

function clampInt(raw, fallback, min, max) {
  const parsed = raw == null ? fallback : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function sha256Text(text) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hermesTimestampToMillis(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const trimmed = value.trim();
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return numeric > 10_000_000_000 ? numeric : numeric * 1000;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
}

function hermesTimestampToIso(value) {
  const millis = hermesTimestampToMillis(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : undefined;
}

function safeJsonParse(value) {
  if (!nonEmptyString(value)) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function normalizeMessageContent(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const parsed = safeJsonParse(trimmed);
  if (Array.isArray(parsed)) {
    const text = parsed
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          if (typeof item.text === "string") return item.text;
          if (typeof item.content === "string") return item.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  return trimmed;
}

function renderTranscript(messages) {
  return messages
    .map((message) => {
      const label = message.role === "user" ? "User" : "Assistant";
      const timestampIso = hermesTimestampToIso(message.timestamp);
      const timestamp = timestampIso ? ` [${timestampIso}]` : "";
      return `${label}${timestamp}:\n${normalizeMessageContent(message.content)}`;
    })
    .filter((value) => !value.endsWith(":\n"))
    .join("\n\n");
}

function keywordHits(text, patterns) {
  const lower = text.toLowerCase();
  return patterns.reduce((count, pattern) => count + (lower.includes(pattern) ? 1 : 0), 0);
}

const TECHNICAL = [
  "debug",
  "error",
  "bug",
  "fix",
  "sqlite",
  "database",
  "postgres",
  "hermes",
  "deploy",
  "除錯",
  "錯誤",
  "修復",
  "資料庫",
  "部署",
  "連線",
];
const PROJECT = [
  "project",
  "repo",
  "repository",
  "architecture",
  "handoff",
  "roadmap",
  "milestone",
  "專案",
  "架構",
  "開發",
  "交接",
  "邊界",
];
const PREFERENCE = [
  "prefer",
  "preference",
  "rather than",
  "instead",
  "i like",
  "比較喜歡",
  "偏好",
  "不要",
  "改成",
  "以前",
  "現在",
  "更喜歡",
];
const INFERENCE = [
  "therefore",
  "this means",
  "it implies",
  "insight",
  "hypothesis",
  "therefore",
  "因此",
  "所以",
  "代表",
  "推論",
  "推測",
  "意味著",
  "應該",
  "結論",
];

function scoreSession(session) {
  const searchable = `${session.title || ""}\n${session.transcript.slice(0, 80_000)}`;
  const technical = keywordHits(searchable, TECHNICAL);
  const project = keywordHits(searchable, PROJECT);
  const preference = keywordHits(searchable, PREFERENCE);
  const inference = keywordHits(searchable, INFERENCE);
  const count = Number(session.message_count || session.messages.length || 0);
  return {
    technical_debugging: technical * 10 + Math.min(count, 20) / 20,
    long_project_conversation:
      project * 8 + (count >= 25 ? 15 : count >= 15 ? 6 : 0) + Math.min(count, 100) / 100,
    preference_change: preference * 12 + (preference >= 2 ? 8 : 0),
    inferred_insight: inference * 12 + project * 2,
    ordinary_conversation:
      count >= 4 && count <= 24 && technical === 0 && project === 0 && preference === 0
        ? 20 - inference * 2
        : 0,
  };
}

function choosePilotSessions(sessions) {
  const scored = sessions.map((session) => ({ ...session, scores: scoreSession(session) }));
  const selected = [];
  const used = new Set();
  const order = [
    "preference_change",
    "inferred_insight",
    "technical_debugging",
    "long_project_conversation",
    "ordinary_conversation",
  ];

  for (const category of order) {
    const best = scored
      .filter((session) => !used.has(session.id))
      .sort((a, b) => b.scores[category] - a.scores[category])[0];
    if (!best) continue;
    const score = best.scores[category];
    selected.push({
      category,
      selection: score > 0 ? "heuristic_match" : "fallback",
      score,
      session: best,
    });
    used.add(best.id);
  }

  if (selected.length < CATEGORIES.length) {
    throw new Error(`Only ${selected.length} distinct eligible sessions were found; five are required.`);
  }
  return selected;
}

function sessionIsCompleted(row, cutoffMs) {
  if (Number(row.archived) === 1 || Number(row.expiry_finalized) === 1) return true;
  if (Number.isFinite(hermesTimestampToMillis(row.ended_at))) return true;
  const activityMs = hermesTimestampToMillis(row.last_activity_at ?? row.started_at);
  return Number.isFinite(activityMs) && activityMs <= cutoffMs;
}

function readPilotSource(dbPath) {
  if (!existsSync(dbPath)) throw new Error(`Hermes state.db not found: ${dbPath}`);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("BEGIN");
    const schemaRows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const tableNames = new Set(schemaRows.map((row) => row.name));
    if (!tableNames.has("sessions") || !tableNames.has("messages")) {
      throw new Error("Hermes database is missing sessions/messages tables.");
    }
    const cutoffMs = Date.now() - 48 * 60 * 60 * 1000;
    const rows = db
      .prepare(
        `SELECT id, source, profile_name, title, message_count, started_at, ended_at,
                last_activity_at, end_reason, archived, expiry_finalized, hidden
           FROM sessions
          WHERE COALESCE(hidden,0)=0 AND COALESCE(message_count,0)>=2
          ORDER BY COALESCE(ended_at,last_activity_at,started_at) DESC
          LIMIT ?`,
      )
      .all(candidateLimit);

    const sessions = [];
    const messageStmt = db.prepare(
      `SELECT id, role, content, timestamp
         FROM messages
        WHERE session_id=?
          AND role IN ('user','assistant')
          AND content IS NOT NULL
        ORDER BY id ASC`,
    );

    for (const row of rows) {
      if (!sessionIsCompleted(row, cutoffMs)) continue;
      const messages = messageStmt
        .all(row.id)
        .map((message) => ({
          id: Number(message.id),
          role: String(message.role),
          content: String(message.content ?? ""),
          timestamp: message.timestamp == null ? undefined : message.timestamp,
        }))
        .filter((message) => normalizeMessageContent(message.content).length > 0);
      if (messages.length < 2) continue;
      const transcript = renderTranscript(messages);
      if (!transcript || transcript.length > maxTranscriptChars) continue;
      sessions.push({
        ...row,
        id: String(row.id),
        title: row.title == null ? "" : String(row.title),
        messages,
        transcript,
        transcriptChecksum: sha256Text(transcript),
      });
    }
    db.exec("COMMIT");
    return choosePilotSessions(sessions);
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    db.close();
  }
}

function loadPlanManifest(path) {
  if (!path) {
    throw new Error("DLMF_PILOT_PLAN_MANIFEST is required with --apply.");
  }
  if (!existsSync(path)) {
    throw new Error(`Production pilot plan manifest not found: ${path}`);
  }
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.sessions)) {
    throw new Error("Production pilot plan manifest is malformed.");
  }
  if (parsed.source?.databasePath !== hermesDb) {
    throw new Error("Production pilot plan manifest was created from a different Hermes database path.");
  }
  if (parsed.sessions.length !== CATEGORIES.length) {
    throw new Error("Production pilot plan manifest must contain exactly five sessions.");
  }
  const categories = new Set(parsed.sessions.map((entry) => entry.category));
  const sessionIds = new Set(parsed.sessions.map((entry) => entry.sessionId));
  if (
    categories.size !== CATEGORIES.length ||
    !CATEGORIES.every((category) => categories.has(category)) ||
    sessionIds.size !== CATEGORIES.length
  ) {
    throw new Error("Production pilot plan manifest must contain five distinct canonical categories/session IDs.");
  }
  for (const entry of parsed.sessions) {
    if (!nonEmptyString(entry.sessionId) || !nonEmptyString(entry.transcriptChecksum)) {
      throw new Error("Production pilot plan manifest is missing session IDs or transcript checksums.");
    }
  }
  return parsed;
}

function readPinnedPilotSource(dbPath, planManifest) {
  if (!existsSync(dbPath)) throw new Error(`Hermes state.db not found: ${dbPath}`);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("BEGIN");
    const sessionStmt = db.prepare(
      `SELECT id, source, profile_name, title, message_count, started_at, ended_at,
              last_activity_at, end_reason, archived, expiry_finalized, hidden
         FROM sessions
        WHERE id=?`,
    );
    const messageStmt = db.prepare(
      `SELECT id, role, content, timestamp
         FROM messages
        WHERE session_id=?
          AND role IN ('user','assistant')
          AND content IS NOT NULL
        ORDER BY id ASC`,
    );
    const cutoffMs = Date.now() - 48 * 60 * 60 * 1000;
    const selected = [];

    for (const planned of planManifest.sessions) {
      const row = sessionStmt.get(planned.sessionId);
      if (!row) throw new Error(`Pinned Hermes session disappeared: ${planned.sessionId}`);
      if (Number(row.hidden) === 1) {
        throw new Error(`Pinned Hermes session became hidden: ${planned.sessionId}`);
      }
      if (!sessionIsCompleted(row, cutoffMs)) {
        throw new Error(`Pinned Hermes session is no longer eligible as completed/quiescent: ${planned.sessionId}`);
      }
      const messages = messageStmt
        .all(row.id)
        .map((message) => ({
          id: Number(message.id),
          role: String(message.role),
          content: String(message.content ?? ""),
          timestamp: message.timestamp == null ? undefined : message.timestamp,
        }))
        .filter((message) => normalizeMessageContent(message.content).length > 0);
      if (messages.length < 2) {
        throw new Error(`Pinned Hermes session no longer has enough messages: ${planned.sessionId}`);
      }
      const transcript = renderTranscript(messages);
      if (!transcript || transcript.length > maxTranscriptChars) {
        throw new Error(`Pinned Hermes transcript is empty or exceeds pilot bounds: ${planned.sessionId}`);
      }
      const transcriptChecksum = sha256Text(transcript);
      if (transcriptChecksum !== planned.transcriptChecksum) {
        throw new Error(`Pinned Hermes transcript changed after plan: ${planned.sessionId}`);
      }
      selected.push({
        category: planned.category,
        selection: planned.selection ?? "plan_pinned",
        score: Number(planned.score ?? 0),
        session: {
          ...row,
          id: String(row.id),
          title: row.title == null ? "" : String(row.title),
          messages,
          transcript,
          transcriptChecksum,
        },
      });
    }
    db.exec("COMMIT");
    return selected;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    db.close();
  }
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

async function writePrivateJson(path, value) {
  await ensurePrivateDirectory(dirname(path));
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function manifestFor(selected) {
  return {
    runId,
    createdAt: new Date().toISOString(),
    source: {
      type: "hermes_state_db",
      databasePath: hermesDb,
      readOnly: true,
    },
    safety: {
      writesHermes: false,
      prunesHermes: false,
      canonicalNamespace: namespace,
      postgresSchema: APPLY ? schema : null,
      hindsightDistillationBank: APPLY ? distillationBank : null,
      hindsightProjectionBank: APPLY ? projectionBank : null,
    },
    sessions: selected.map(({ category, selection, score, session }) => ({
      category,
      selection,
      score,
      sessionId: session.id,
      source: session.source,
      profileName: session.profile_name,
      title: session.title,
      messageCount: session.message_count,
      extractedMessageCount: session.messages.length,
      transcriptChars: session.transcript.length,
      transcriptChecksum: session.transcriptChecksum,
      startedAt: hermesTimestampToIso(session.started_at),
      endedAt: hermesTimestampToIso(session.ended_at),
      lastActivityAt: hermesTimestampToIso(session.last_activity_at),
      endReason: session.end_reason,
    })),
  };
}

function assertPilotSafety() {
  if (!namespace.startsWith("pilot.")) {
    throw new Error(`DLMF_PILOT_NAMESPACE must start with 'pilot.': ${namespace}`);
  }
  if (!/^dlmf_pilot_[a-z0-9_]+$/.test(schema)) {
    throw new Error(`DLMF_PILOT_SCHEMA must be an isolated dlmf_pilot_* schema: ${schema}`);
  }
  if (!distillationBank.includes("pilot") || !projectionBank.includes("pilot")) {
    throw new Error("Both Hindsight banks must be explicitly pilot-isolated.");
  }
  if (distillationBank === projectionBank) {
    throw new Error("Hindsight distillation and projection banks must differ.");
  }
}

async function readHermesHindsightConfig() {
  const path = join(hermesHome, "hindsight", "config.json");
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(await readFile(path, "utf8"));
  return parsed && typeof parsed === "object" ? parsed : {};
}

function readSimpleEnvFile(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (value.length >= 2 && value[0] === value.at(-1) && ["'", '"'].includes(value[0])) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function secretFingerprint(value) {
  if (!nonEmptyString(value)) return "none";
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

function dedupeAuthCandidates(candidates) {
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    const identity = candidate.apiKey ?? "<none>";
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(candidate);
  }
  return result;
}

async function probeHindsightTenantAuth(baseUrl, authCandidates) {
  const attempts = [];
  for (const candidate of authCandidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(`${baseUrl}/v1/default/banks?limit=1`, {
        method: "GET",
        headers: candidate.apiKey ? { Authorization: `Bearer ${candidate.apiKey}` } : {},
        signal: controller.signal,
      });
      const body = await response.text();
      if (response.ok) {
        return {
          ...candidate,
          authHealthy: true,
          fingerprint: secretFingerprint(candidate.apiKey),
          attempts,
        };
      }
      const lower = body.toLowerCase();
      const authenticationFailure =
        response.status === 401 ||
        response.status === 403 ||
        lower.includes("authentication failed") ||
        lower.includes("invalid api key") ||
        lower.includes("missing authorization");
      attempts.push({
        source: candidate.source,
        status: response.status,
        authenticationFailure,
      });
      if (!authenticationFailure) {
        throw new Error(`Hindsight bank auth probe failed with HTTP ${response.status}`);
      }
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error("Hindsight bank auth probe timed out");
      }
      if (String(error?.message || error).includes("Hindsight bank auth probe failed")) throw error;
      attempts.push({ source: candidate.source, status: 0, authenticationFailure: false });
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    apiKey: undefined,
    source: "none",
    authHealthy: false,
    fingerprint: "none",
    attempts,
  };
}

async function resolveHindsightConnection({ probeAuth = true } = {}) {
  const config = await readHermesHindsightConfig();
  const hermesEnv = readSimpleEnvFile(join(hermesHome, ".env"));
  const mode = String(config.mode || "cloud");
  const defaultUrl = mode === "local" || mode === "local_embedded" || mode === "local_external"
    ? "http://localhost:8888"
    : "https://api.hindsight.vectorize.io";
  const baseUrl = String(
    process.env.DLMF_PILOT_HINDSIGHT_URL || config.api_url || config.apiUrl || defaultUrl,
  ).replace(/\/$/, "");

  const authCandidates = dedupeAuthCandidates([
    ...(nonEmptyString(process.env.DLMF_PILOT_HINDSIGHT_API_KEY)
      ? [{ source: "pilot_override", apiKey: process.env.DLMF_PILOT_HINDSIGHT_API_KEY }]
      : []),
    ...(nonEmptyString(hermesEnv.HINDSIGHT_API_KEY)
      ? [{ source: "hermes_env", apiKey: hermesEnv.HINDSIGHT_API_KEY }]
      : []),
    ...(nonEmptyString(config.api_key || config.apiKey)
      ? [{ source: "hindsight_config", apiKey: config.api_key || config.apiKey }]
      : []),
    { source: "no_auth", apiKey: undefined },
  ]);

  const selected = probeAuth
    ? await probeHindsightTenantAuth(baseUrl, authCandidates)
    : {
        ...authCandidates[0],
        authHealthy: undefined,
        fingerprint: secretFingerprint(authCandidates[0]?.apiKey),
        attempts: [],
      };

  return {
    baseUrl,
    apiKey: selected.apiKey,
    authSource: selected.source,
    authHealthy: selected.authHealthy,
    authFingerprint: selected.fingerprint,
    authAttempts: selected.attempts,
    mode,
  };
}

async function loadHindsightClientConstructor() {
  if (process.env.DLMF_PILOT_HINDSIGHT_CLIENT_MODULE) {
    const module = await import(pathToFileURL(resolve(process.env.DLMF_PILOT_HINDSIGHT_CLIENT_MODULE)).href);
    if (typeof module.HindsightClient !== "function") throw new Error("Configured Hindsight module has no HindsightClient export.");
    return module.HindsightClient;
  }
  const omniHarnessDir = resolve(process.env.OMNIHARNESS_DIR || join(dirname(dirname(dirname(import.meta.filename))), "..", "OmniHarness"));
  const candidate = join(
    omniHarnessDir,
    "node_modules",
    "@vectorize-io",
    "hindsight-client",
    "dist",
    "index.mjs",
  );
  if (!existsSync(candidate)) {
    throw new Error(
      "Hindsight TypeScript client was not found. Set OMNIHARNESS_DIR or DLMF_PILOT_HINDSIGHT_CLIENT_MODULE.",
    );
  }
  const module = await import(pathToFileURL(candidate).href);
  if (typeof module.HindsightClient !== "function") throw new Error("Hindsight client module has no HindsightClient export.");
  return module.HindsightClient;
}

function commandVersion(command, versionArgs = ["--version"]) {
  const result = spawnSync(command, versionArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) return undefined;
  return String(result.stdout || result.stderr || "").trim().split("\n")[0] || "available";
}

function postgresLocalHints() {
  return {
    psql: commandVersion("psql"),
    pgIsReady: commandVersion("pg_isready", ["--version"]),
    defaultSocketVisible:
      existsSync("/var/run/postgresql/.s.PGSQL.5432") ||
      existsSync("/run/postgresql/.s.PGSQL.5432"),
  };
}

function redactedDatabaseTarget(databaseUrl) {
  if (!nonEmptyString(databaseUrl)) return undefined;
  try {
    const url = new URL(databaseUrl);
    return {
      host: url.hostname,
      port: url.port || "default",
      database: url.pathname.replace(/^\//, "") || "default",
      credentialsPresent: Boolean(url.username || url.password),
    };
  } catch {
    return {
      host: "unparsed",
      port: "unknown",
      database: "unknown",
      credentialsPresent: true,
    };
  }
}

async function runPreflight() {
  assertPilotSafety();
  const selected = readPilotSource(hermesDb);
  const hindsightConnection = await resolveHindsightConnection();
  const databaseUrl = pilotDatabaseUrl();

  let hindsightHealth = "unavailable";
  let hindsightAuth = hindsightConnection.authHealthy === true ? "healthy" : "unavailable";
  let hindsightVersion = "unknown";
  try {
    const HindsightClient = await loadHindsightClientConstructor();
    const client = new HindsightClient({
      baseUrl: hindsightConnection.baseUrl,
      userAgent: "dlmf-production-pilot-preflight/0.1.1",
      ...(hindsightConnection.apiKey ? { apiKey: hindsightConnection.apiKey } : {}),
    });
    const version = await probeHindsight(
      client,
      hindsightConnection.baseUrl,
      hindsightConnection.apiKey,
    );
    hindsightHealth = "healthy";
    hindsightVersion = String(version.api_version || version.version || "unknown");
  } catch {
    hindsightHealth = "unavailable";
  }
  if (hindsightConnection.authHealthy !== true) hindsightAuth = "unavailable";

  let postgresHealth = nonEmptyString(databaseUrl) ? "unavailable" : "unconfigured";
  if (nonEmptyString(databaseUrl)) {
    const probePool = new Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 5_000,
    });
    try {
      await probePool.query("SELECT 1 AS ready");
      postgresHealth = "healthy";
    } catch {
      postgresHealth = "unavailable";
    } finally {
      await probePool.end().catch(() => undefined);
    }
  }

  const localHints = postgresLocalHints();
  const target = redactedDatabaseTarget(databaseUrl);
  const endpointKind =
    hindsightConnection.baseUrl.startsWith("http://localhost") ||
    hindsightConnection.baseUrl.startsWith("http://127.0.0.1")
      ? "local"
      : "remote";

  console.log("DLMF Production Pilot PREFLIGHT");
  console.log(`Hermes DB readable: ${existsSync(hermesDb)}`);
  console.log(`Five-session sample: ${selected.length === 5 ? "ready" : "not-ready"}`);
  console.log(
    `Hindsight: mode=${hindsightConnection.mode} endpoint=${endpointKind} health=${hindsightHealth} auth=${hindsightAuth} auth_source=${hindsightConnection.authSource} key_fp=${hindsightConnection.authFingerprint} version=${hindsightVersion}`,
  );
  console.log(`DLMF PostgreSQL: configured=${nonEmptyString(databaseUrl)} source=${process.env.DLMF_PILOT_DATABASE_URL ? "environment" : existsSync(pilotEnvFile) ? "private_file" : "none"} health=${postgresHealth}`);
  console.log(
    `Local PostgreSQL hints: psql=${localHints.psql ? "yes" : "no"} pg_isready=${localHints.pgIsReady ? "yes" : "no"} socket5432=${localHints.defaultSocketVisible}`,
  );
  if (target) {
    console.log(
      `DLMF PostgreSQL target: ${target.host}:${target.port}/${target.database} credentials=${target.credentialsPresent ? "present" : "absent"}`,
    );
  }

  const ready =
    existsSync(hermesDb) &&
    selected.length === 5 &&
    hindsightHealth === "healthy" &&
    hindsightAuth === "healthy" &&
    postgresHealth === "healthy";

  console.log(`PRODUCTION_PILOT_PREFLIGHT=${ready ? "PASS" : "BLOCKED"}`);
  if (!nonEmptyString(databaseUrl)) {
    console.log("BLOCKER=DLMF_PILOT_DATABASE_URL_NOT_CONFIGURED");
  } else if (postgresHealth !== "healthy") {
    console.log("BLOCKER=DLMF_PILOT_DATABASE_NOT_REACHABLE");
  }
  if (hindsightHealth !== "healthy") {
    console.log("BLOCKER=HINDSIGHT_NOT_HEALTHY");
  }
  if (hindsightAuth !== "healthy") {
    console.log("BLOCKER=HINDSIGHT_AUTH_NOT_VALID");
  }
  return ready;
}

async function probeHindsight(client, baseUrl, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${baseUrl}/health`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Hindsight health HTTP ${response.status}`);
  } finally {
    clearTimeout(timer);
  }
  const version = await client.getVersion();
  return version;
}

async function createPilotPostgres(databaseUrl) {
  if (!nonEmptyString(databaseUrl)) throw new Error("DLMF_PILOT_DATABASE_URL is required with --apply.");
  const admin = new Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.end();

  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  });
  for (const migration of [
    "migrations/0001_canonical_core.sql",
    "migrations/0002_central_operations.sql",
    "migrations/0003_memory_distillation.sql",
  ]) {
    await pool.query(await readFile(resolve(migration), "utf8"));
  }
  return pool;
}

async function projectCanonicalRevision(client, revision) {
  const response = await client.retain(projectionBank, revision.canonicalContent.text, {
    documentId: `dlmf-canonical:${revision.memoryId}:r${revision.revision}`,
    context: "DLMF canonical memory projection for production pilot",
    metadata: {
      dlmf_plane: "canonical_projection",
      dlmf_memory_id: revision.memoryId,
      dlmf_revision: String(revision.revision),
      dlmf_epistemic_status: revision.epistemicStatus,
      dlmf_semantic_fingerprint: revision.semanticFingerprint,
    },
    tags: ["dlmf", "canonical_projection", "production_pilot"],
    async: false,
  });
  if (!response.success || response.async || response.bank_id !== projectionBank) {
    throw new Error(`Canonical projection retain was not synchronously materialized for ${revision.memoryId}.`);
  }
  return response;
}

async function runApply(selected, manifest) {
  assertPilotSafety();
  const databaseUrl = pilotDatabaseUrl();
  if (!nonEmptyString(databaseUrl)) {
    throw new Error("DLMF pilot PostgreSQL is not configured; run pilot:memory-distillation:bootstrap-postgres or set DLMF_PILOT_DATABASE_URL.");
  }
  const hindsightConnection = await resolveHindsightConnection();
  if (hindsightConnection.authHealthy !== true) {
    throw new Error("Hindsight tenant authentication could not be validated by the read-only bank API.");
  }
  const HindsightClient = await loadHindsightClientConstructor();
  const hindsightClient = new HindsightClient({
    baseUrl: hindsightConnection.baseUrl,
    userAgent: "dlmf-production-pilot/0.1.1",
    ...(hindsightConnection.apiKey ? { apiKey: hindsightConnection.apiKey } : {}),
  });
  const hindsightVersion = await probeHindsight(
    hindsightClient,
    hindsightConnection.baseUrl,
    hindsightConnection.apiKey,
  );

  const pool = await createPilotPostgres(databaseUrl);
  const canonicalStore = new PostgresCanonicalMemoryStore(pool);
  const receiptStore = new PostgresDistillationReceiptStore(pool);
  const archive = new FilesystemRawExperienceArchiveProvider(archiveRoot);
  const governance = new EvidenceBoundMemoryGovernance("pilot-canonicalize-v1");
  const adapter = new HindsightMemoryAdapter({
    client: hindsightClient,
    adapterVersion: "hindsight-production-pilot-v0.1.1",
    providerVersion: String(hindsightVersion.api_version || hindsightVersion.version || "unknown"),
    banks: {
      distillationBankId: () => distillationBank,
      projectionBankId: () => projectionBank,
    },
    recallBudget: "mid",
    reflectBudget: "mid",
  });
  const distillation = new TranscriptDistillationService({
    canonicalStore,
    receiptStore,
    archive,
    provider: adapter,
    governance,
  });
  const eligibility = new PruneEligibilityService(
    receiptStore,
    archive,
    new PreservationCompleteRetentionPolicy("pilot-retention-v1"),
  );

  const scope = { tenantId, lifeDid, memoryNamespace: namespace };
  const sessionReports = [];
  const allCanonicalRevisions = [];

  try {
    for (const selectedSession of selected) {
      const { category, session } = selectedSession;
      const receipt = await distillation.run({
        scope,
        origin: {
          lifeDid,
          agentId: "nancy",
          runtimeId: "hermes-gb10",
          deviceId: "gb10",
        },
        sourceType: "hermes_session",
        sourceId: session.id,
        content: session.transcript,
        contentType: "text/plain; profile=hermes-transcript",
        ...(hermesTimestampToIso(session.started_at)
          ? { createdAt: hermesTimestampToIso(session.started_at) }
          : {}),
        ...(hermesTimestampToIso(session.started_at)
          ? { observedAt: hermesTimestampToIso(session.started_at) }
          : {}),
        metadata: {
          pilotCategory: category,
          source: session.source || "",
          profileName: session.profile_name || "",
          title: session.title || "",
          messageCount: Number(session.message_count || 0),
        },
        distillationPolicyVersion: "pilot-distill-v1",
        canonicalizationPolicyVersion: governance.policyVersion,
        retentionPolicyVersion: "pilot-retention-v1",
      });

      const candidates = [];
      for (const candidateId of receipt.candidateIds) {
        const candidate = await canonicalStore.getCandidate(candidateId);
        if (candidate) {
          candidates.push({
            candidateId: candidate.candidateId,
            candidateType: candidate.candidateType,
            memoryClass: candidate.memoryClass,
            memoryKind: candidate.memoryKind,
            text: candidate.proposedContent.text,
            epistemicStatus: candidate.epistemicStatus,
            confidence: candidate.confidence,
            status: candidate.status,
            fingerprint: candidate.candidateFingerprint,
            evidenceRefs: candidate.evidenceRefs,
          });
        }
      }

      const canonical = [];
      for (const memoryId of receipt.canonicalMemoryIds) {
        const head = await canonicalStore.getHead(memoryId);
        if (!head) continue;
        const revision = await canonicalStore.getRevision(memoryId, head.currentRevision);
        if (!revision) continue;
        canonical.push({
          memoryId,
          revision: revision.revision,
          text: revision.canonicalContent.text,
          epistemicStatus: revision.epistemicStatus,
          semanticFingerprint: revision.semanticFingerprint,
          evidenceRefs: revision.evidenceRefs,
        });
        allCanonicalRevisions.push(revision);
        await projectCanonicalRevision(hindsightClient, revision);
      }

      const pruneDecision = await eligibility.refresh(scope, "hermes_session", session.id);
      sessionReports.push({
        category,
        sessionId: session.id,
        title: session.title,
        rawTranscript: {
          checksum: session.transcriptChecksum,
          chars: session.transcript.length,
          archiveRef: receipt.rawArchiveRef,
        },
        receipt: {
          receiptId: receipt.receiptId,
          status: receipt.status,
          canonicalizationOutcome: receipt.canonicalizationOutcome,
          providerRunId: receipt.providerRunId,
          candidateIds: receipt.candidateIds,
          canonicalMemoryIds: receipt.canonicalMemoryIds,
          warnings: receipt.warnings,
          errors: receipt.errors,
        },
        candidates,
        canonical,
        pruneEligibility: pruneDecision,
        deletionExecuted: false,
      });
    }

    const inferenceSample = sessionReports.find((entry) => entry.category === "inferred_insight");
    let reflection = { status: "not_run", produced: 0, candidates: [] };
    if (inferenceSample && allCanonicalRevisions.length > 0) {
      const relatedIds = new Set(inferenceSample.receipt.canonicalMemoryIds);
      const related = allCanonicalRevisions.filter((revision) => relatedIds.has(revision.memoryId));
      const reflectionSource = related.length > 0 ? related : allCanonicalRevisions.slice(0, 5);
      const reflective = new ReflectiveMemoryService(canonicalStore, adapter);
      try {
        const derived = await reflective.reflect({
          scope,
          origin: { lifeDid, agentId: "nancy", runtimeId: "hermes-gb10", deviceId: "gb10" },
          context:
            "Identify one useful pattern or hypothesis from these canonical memories. Treat it as an inference, not an observed fact.",
          evidence: reflectionSource.map((revision) => ({
            evidenceRef: {
              sourceType: "canonical_memory",
              sourceRef: `${revision.memoryId}@${revision.revision}`,
            },
            text: revision.canonicalContent.text,
            sourceExperienceRefs: revision.sourceExperienceRefs,
          })),
          canonicalMemories: reflectionSource,
          distillationPolicyVersion: "pilot-reflect-v1",
        });
        reflection = {
          status: "complete",
          produced: derived.length,
          candidates: derived.map((candidate) => ({
            candidateId: candidate.candidateId,
            text: candidate.proposedContent.text,
            epistemicStatus: candidate.epistemicStatus,
            status: candidate.status,
            canonicalWritePerformed: false,
          })),
        };
      } catch (error) {
        reflection = {
          status: "failed",
          produced: 0,
          candidates: [],
          error: {
            name: error instanceof Error ? error.name : "Error",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }

    const report = {
      ...manifest,
      appliedAt: new Date().toISOString(),
      environment: {
        postgresSchema: schema,
        hindsightMode: hindsightConnection.mode,
        hindsightApiVersion: hindsightVersion.api_version || hindsightVersion.version || "unknown",
        distillationBank,
        projectionBank,
      },
      sessions: sessionReports,
      reflection,
      finalSafety: {
        hermesWrites: 0,
        hermesDeletes: 0,
        productionHindsightBankWrites: 0,
        productionCanonicalNamespaceWrites: 0,
        pilotPostgresSchemaPreservedForReview: true,
      },
    };
    await writePrivateJson(reportPath, report);
    return report;
  } finally {
    await canonicalStore.close();
  }
}

async function main() {
  if (PREFLIGHT) {
    const ready = await runPreflight();
    if (!ready) process.exitCode = 2;
    return;
  }

  const planManifest = APPLY ? loadPlanManifest(planManifestPath) : undefined;
  const selected = APPLY
    ? readPinnedPilotSource(hermesDb, planManifest)
    : readPilotSource(hermesDb);
  const manifest = manifestFor(selected);
  if (APPLY) {
    manifest.planManifest = planManifestPath;
    manifest.planRunId = planManifest.runId;
    manifest.planPinned = true;
  }
  await writePrivateJson(manifestPath, manifest);

  console.log(`DLMF Production Pilot ${PLAN_ONLY ? "PLAN" : "APPLY"}`);
  console.log(`Hermes DB: ${hermesDb}`);
  console.log(`Manifest: ${manifestPath}`);
  for (const item of manifest.sessions) {
    console.log(
      `${item.category}: session=${item.sessionId} messages=${item.extractedMessageCount} chars=${item.transcriptChars} selection=${item.selection}`,
    );
  }

  if (APPLY) {
    console.log(`PLAN_PINNED=${planManifestPath}`);
    console.log(`PLAN_RUN_ID=${planManifest.runId}`);
  }

  if (PLAN_ONLY) {
    console.log("PILOT_PLAN=PASS");
    console.log("No Hindsight, PostgreSQL, Canonical Memory, or Hermes writes were performed.");
    return;
  }

  const report = await runApply(selected, manifest);
  console.log(`Report: ${reportPath}`);
  for (const item of report.sessions) {
    console.log(
      `${item.category}: receipt=${item.receipt.status}/${item.receipt.canonicalizationOutcome} candidates=${item.candidates.length} canonical=${item.canonical.length} pruneEligible=${item.pruneEligibility.eligible}`,
    );
  }
  const failedSessions = report.sessions.filter((item) => item.receipt.status !== "complete");
  const pendingOutcomes = report.sessions.filter(
    (item) => item.receipt.canonicalizationOutcome === "pending",
  );
  const totalCandidates = report.sessions.reduce((sum, item) => sum + item.candidates.length, 0);
  const totalCanonical = report.sessions.reduce((sum, item) => sum + item.canonical.length, 0);
  const reflectionCount = report.reflection?.produced ?? 0;
  const executionFailures = [];
  if (failedSessions.length > 0) {
    executionFailures.push(`RECEIPTS_NOT_COMPLETE:${failedSessions.length}`);
  }
  if (pendingOutcomes.length > 0) {
    executionFailures.push(`CANONICALIZATION_PENDING:${pendingOutcomes.length}`);
  }
  if (totalCandidates === 0) executionFailures.push("NO_CANDIDATES_PRODUCED");
  if (totalCanonical === 0) executionFailures.push("NO_CANONICAL_MEMORY_PRODUCED");
  if (report.reflection?.status === "failed") executionFailures.push("REFLECTION_FAILED");
  if (reflectionCount === 0) executionFailures.push("NO_REFLECTIVE_CANDIDATE_PRODUCED");

  console.log(`reflection_status=${report.reflection?.status ?? "not_run"}`);
  console.log(`reflection_candidates=${reflectionCount}`);
  console.log("HERMES_PRUNE_EXECUTED=false");
  if (executionFailures.length > 0) {
    for (const failure of executionFailures) console.error(`PILOT_FAILURE=${failure}`);
    console.error("PRODUCTION_PILOT=FAIL");
    process.exitCode = 1;
    return;
  }
  console.log("PRODUCTION_PILOT=PASS");
}

main().catch((error) => {
  console.error(`PRODUCTION_PILOT=FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
