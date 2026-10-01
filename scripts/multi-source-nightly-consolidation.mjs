#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scripts = [
  new URL("./codex-incremental-sync-worker.mjs", import.meta.url),
  new URL("./chatgpt-capture-sync-worker.mjs", import.meta.url),
];

const results = [];
for (const scriptUrl of scripts) {
  const script = fileURLToPath(scriptUrl);
  const result = await runWorker(script);
  results.push(result);
  if (result.exitCode !== 0 && result.exitCode !== 75) {
    console.error(
      `DLMF_MULTI_SOURCE_NIGHTLY=FAIL source=${result.source} exitCode=${result.exitCode}`,
    );
    process.exit(result.exitCode || 1);
  }
}

const busy = results.filter((result) => result.exitCode === 75).length;
const state = busy === 0 ? "PASS" : "DEFERRED";
console.log(
  `DLMF_MULTI_SOURCE_NIGHTLY=${state} sources=${results.length} busy=${busy} `
  + `writeMode=${process.env.DLMF_MULTI_SOURCE_WRITE_MODE?.trim() || "reference_only"} `
  + "historicalFullImport=0",
);
if (busy > 0) process.exitCode = 75;

function runWorker(script) {
  const source = script.includes("codex-") ? "codex" : "chatgpt";
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 64 * 1024) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 64 * 1024) child.kill("SIGTERM");
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      const exitCode = typeof code === "number" ? code : 1;
      const summary = stdout
        .split(/\r?\n/u)
        .find((line) => line.startsWith("DLMF_") && line.includes("=PASS"));
      if (summary) console.log(summary);
      if (exitCode === 75) {
        console.log(`DLMF_MULTI_SOURCE_CHILD=BUSY source=${source}`);
      } else if (exitCode !== 0) {
        console.error(
          `DLMF_MULTI_SOURCE_CHILD=FAIL source=${source} signal=${signal || "none"} stderrBytes=${Buffer.byteLength(stderr)}`,
        );
      }
      resolvePromise({ source, exitCode });
    });
  });
}
