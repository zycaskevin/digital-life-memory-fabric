import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { checkRelationshipOsIngressConfig } from "./relationship-os-ingress-config-lib.mjs";

const envArg = process.argv[2];
if (!envArg) {
  console.error("usage: node scripts/check-relationship-os-ingress-config.mjs <environment-file>");
  process.exit(2);
}

const result = checkRelationshipOsIngressConfig(
  await readFile(resolve(envArg), "utf8"),
  { rootDir: process.cwd() },
);

if (!result.ok) {
  for (const error of result.errors) console.error(`FAIL=${error}`);
  process.exit(1);
}
for (const line of result.publicSummary) console.log(line);
