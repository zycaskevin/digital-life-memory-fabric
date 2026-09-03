import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const path = process.argv[2] ? resolve(process.argv[2]) : process.env.DLMF_PILOT_REPORT;
if (!path) {
  console.error("Usage: node inspect-memory-distillation-report.mjs /path/to/pilot-report.json");
  process.exit(2);
}

const report = JSON.parse(readFileSync(path, "utf8"));

function fingerprint(value) {
  return `sha256:${createHash("sha256").update(String(value), "utf8").digest("hex")}`;
}

function sanitize(message) {
  let text = String(message ?? "");
  text = text.replace(/(postgres(?:ql)?:\/\/)[^@\s/]+@/gi, "$1<redacted>@");
  text = text.replace(/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, "$1<redacted>@");
  text = text.replace(/(api[_-]?key|token|password|authorization)(["'=:\s]+)[^\s,;}"]+/gi, "$1$2<redacted>");
  return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
}

function classify(message) {
  const text = String(message ?? "").toLowerCase();
  if (text.includes("batch api is enabled") && text.includes("async=false")) {
    return "HINDSIGHT_REQUIRES_ASYNC_RETAIN";
  }
  if (text.includes("timed out") || text.includes("timeout")) return "PROVIDER_TIMEOUT";
  if (text.includes("econnrefused") || text.includes("fetch failed")) return "PROVIDER_UNREACHABLE";
  if (text.includes("status 400") || text.includes("http 400") || text.includes("retain failed")) {
    return "PROVIDER_REQUEST_REJECTED";
  }
  if (text.includes("did not durably accept")) return "PROVIDER_DURABILITY_NOT_PROVEN";
  if (text.includes("mismatched bank")) return "PROVIDER_BANK_MISMATCH";
  return "UNCLASSIFIED_PROVIDER_FAILURE";
}

console.log(`report=${path}`);
console.log(`plan_run_id=${report.planRunId ?? "unknown"}`);
console.log(`applied_at=${report.appliedAt ?? "unknown"}`);
for (const session of report.sessions ?? []) {
  const errors = session.receipt?.errors ?? [];
  console.log(
    `${session.category}: status=${session.receipt?.status ?? "unknown"} outcome=${session.receipt?.canonicalizationOutcome ?? "unknown"} errors=${errors.length}`,
  );
  for (const error of errors) {
    const message = error.message ?? "";
    console.log(`  stage=${error.stage ?? "unknown"} code=${error.code ?? "unknown"}`);
    console.log(`  class=${classify(message)}`);
    console.log(`  message=${sanitize(message)}`);
    console.log(`  fingerprint=${fingerprint(message)}`);
  }
}
console.log(`reflection_candidates=${report.reflection?.produced ?? 0}`);
console.log(`hermes_deletes=${report.finalSafety?.hermesDeletes ?? "unknown"}`);
