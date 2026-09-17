#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { isIP } from "node:net";
import { resolve } from "node:path";

import {
  CoreObservationError,
  coreManifestDigest,
  expectedMemoryScopeRef,
  projectDlmfCoreObservations,
  verifyDlmfCoreManifest,
} from "./core-health-observation-lib.mjs";

const MAX_BYTES = 65_536;

function fail(code) { throw new CoreObservationError(code); }
function parseArgs(argv) {
  const map = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined || map.has(key)) fail("ARGUMENTS_INVALID");
    map.set(key, value);
  }
  for (const key of ["--manifest", "--life-did", "--scope", "--lifetime-db", "--companion-id", "--lifetime-pythonpath", "--output"]) {
    if (!map.has(key)) fail("ARGUMENTS_INVALID");
  }
  return Object.fromEntries([...map].map(([k, v]) => [k.slice(2), v]));
}

function nativeBase(reference) {
  let url;
  try { url = new URL(reference); } catch { fail("NATIVE_ENDPOINT_NOT_ALLOWED"); }
  if (url.protocol !== "http:" || !url.hostname || !isIP(url.hostname)
      || !["127.0.0.1", "::1"].includes(url.hostname)
      || url.username || url.password || url.search || url.hash
      || (url.pathname !== "" && url.pathname !== "/")) fail("NATIVE_ENDPOINT_NOT_ALLOWED");
  return url;
}

function fetchJson(base, path, acceptedStatus) {
  return new Promise((resolvePromise, reject) => {
    const request = http.request(new URL(path, base), {
      method: "GET", timeout: 2_000,
      headers: { accept: "application/json", connection: "close" },
    }, (response) => {
      if (!acceptedStatus.includes(response.statusCode ?? 0)) {
        response.resume(); reject(new CoreObservationError("NATIVE_HTTP_REJECTED")); return;
      }
      if ((response.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase() !== "application/json") {
        response.resume(); reject(new CoreObservationError("NATIVE_CONTENT_TYPE_INVALID")); return;
      }
      let size = 0; const chunks = [];
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) request.destroy(new CoreObservationError("NATIVE_RESPONSE_TOO_LARGE"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        try { resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { reject(new CoreObservationError("NATIVE_JSON_INVALID")); }
      });
    });
    request.on("timeout", () => request.destroy(new CoreObservationError("NATIVE_TIMEOUT")));
    request.on("error", (error) => reject(error instanceof CoreObservationError ? error : new CoreObservationError("NATIVE_UNAVAILABLE")));
    request.end();
  });
}

function verifyIdentity(args, expectedRef) {
  const python = args.python || "python3";
  const environment = {
    ...process.env,
    PYTHONPATH: [resolve(args["lifetime-pythonpath"]), process.env.PYTHONPATH].filter(Boolean).join(":"),
  };
  const run = spawnSync(python, [
    "-m", "lifetime_hub.component_observation",
    "--db", resolve(args["lifetime-db"]),
    "--companion-id", args["companion-id"],
    "--life-did", args["life-did"],
    "--binding-kind", "memory-scope",
    "--expected-ref", expectedRef,
  ], { env: environment, encoding: "utf8", timeout: 5_000, maxBuffer: MAX_BYTES });
  if (run.status !== 0) fail("DLMF_IDENTITY_BINDING_INVALID");
  try { return JSON.parse(run.stdout.trim()); } catch { fail("DLMF_IDENTITY_BINDING_INVALID"); }
}

try {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(resolve(args.manifest), "utf8"));
  const manifestDigest = coreManifestDigest(manifest);
  verifyDlmfCoreManifest(manifest, args["life-did"], manifestDigest);
  const scope = JSON.parse(await readFile(resolve(args.scope), "utf8"));
  const expectedRef = expectedMemoryScopeRef(scope);
  const identityBinding = verifyIdentity(args, expectedRef);
  const base = nativeBase(manifest.endpoint);
  const [health, readiness] = await Promise.all([
    fetchJson(base, "/health", [200]),
    fetchJson(base, "/ready", [200, 503]),
  ]);
  const observations = projectDlmfCoreObservations({
    componentManifest: manifest, manifestDigest, expectedLifeDid: args["life-did"],
    expectedScope: scope, identityBinding, health, readiness,
  });
  await writeFile(resolve(args.output), `${JSON.stringify(observations, null, 2)}\n`, { mode: 0o600 });
  console.log(`DLMF_CORE_OBSERVATION=PASS output=${resolve(args.output)}`);
} catch (error) {
  console.error(`DLMF_CORE_OBSERVATION=FAIL reason=${error instanceof CoreObservationError ? error.code : "NATIVE_VERIFIER_UNAVAILABLE"}`);
  process.exitCode = 1;
}
