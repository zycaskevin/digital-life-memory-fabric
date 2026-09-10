import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { sealInsightPromotionApprovalManifest } from "../../dist/index.js";

const argv = process.argv.slice(2);
function argument(name) {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}
function required(name) {
  const value = argument(name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
const home = process.env.HOME || homedir();
const reportRoot = resolve(
  process.env.DLMF_PILOT_REPORT_ROOT || join(home, ".local", "state", "dlmf", "production-pilot"),
);
const output = resolve(required("--output"));
const relativeOutput = relative(reportRoot, output);
if (relativeOutput === ".." || relativeOutput.startsWith(`..${sep}`)) {
  throw new Error(`Output must stay inside protected report root ${reportRoot}.`);
}
const plan = JSON.parse(await readFile(resolve(required("--plan")), "utf8"));
const draft = JSON.parse(await readFile(resolve(required("--draft")), "utf8"));
const manifest = sealInsightPromotionApprovalManifest({
  formatVersion: "dlmf.insight-promotion-approval.v1",
  planId: plan.planId,
  planChecksum: plan.planChecksum,
  decision: draft.decision,
  reviewedBy: draft.reviewedBy,
  approvalEvidenceIds: draft.approvalEvidenceIds,
  idempotencyKey: draft.idempotencyKey,
  issuedAt: draft.issuedAt,
  expiresAt: draft.expiresAt,
});
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
await chmod(output, 0o600);
console.log(JSON.stringify({ outputPath: output, planId: manifest.planId, manifestChecksum: manifest.manifestChecksum }));
