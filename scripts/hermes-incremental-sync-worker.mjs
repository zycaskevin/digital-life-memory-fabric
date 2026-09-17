#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { inspectDigitalLifeStackSchema, validatedDlmfSchema } from "./digital-life-stack-schema-lib.mjs";

const dlfm = await import(new URL("../dist/index.js", import.meta.url));
const dbPath = resolve(required("DLMF_HERMES_STATE_DB"));
const checkpointPath = resolve(required("DLMF_HERMES_INCREMENTAL_CHECKPOINT"));
const developmentExperienceJournal = process.env.DLMF_HERMES_DEVELOPMENT_EXPERIENCE_JOURNAL?.trim()
  ? resolve(process.env.DLMF_HERMES_DEVELOPMENT_EXPERIENCE_JOURNAL.trim())
  : undefined;
await mkdir(dirname(checkpointPath), { recursive: true, mode: 0o700 });
if (developmentExperienceJournal !== undefined) {
  await mkdir(dirname(developmentExperienceJournal), { recursive: true, mode: 0o700 });
}
const databaseUrl = required("DLMF_DLS_DATABASE_URL");
const schema = validatedDlmfSchema(process.env.DLMF_DLS_SCHEMA || "dlmf_digital_life_stack");
const archiveRoot = resolve(required("DLMF_DLS_ARCHIVE_ROOT"));
const hindsightUrl = required("DLMF_DLS_HINDSIGHT_URL");
const hindsightApiKey = resolveHindsightApiKey();
const omniHarnessDir = resolve(process.env.OMNIHARNESS_DIR || resolve("../OmniHarness"));
const clientModule = process.env.DLMF_DLS_HINDSIGHT_CLIENT_MODULE ? resolve(process.env.DLMF_DLS_HINDSIGHT_CLIENT_MODULE) : resolve(omniHarnessDir,"node_modules","@vectorize-io","hindsight-client","dist","index.mjs");
if (!existsSync(clientModule)) throw new Error("Hindsight client module not found");
const { HindsightClient } = await import(pathToFileURL(clientModule).href);
const hindsightClient = new HindsightClient({baseUrl:hindsightUrl,...(hindsightApiKey?{apiKey:hindsightApiKey}:{})});
const version=await hindsightClient.getVersion();
await assertHindsightAuthentication(hindsightUrl, hindsightApiKey);
const banks=new dlfm.DeterministicHindsightPlaneResolver(process.env.DLMF_DLS_HINDSIGHT_BANK_PREFIX||"dlmf-dls");
const hindsightPort={retain:hindsightClient.retain.bind(hindsightClient),listMemories:hindsightClient.listMemories.bind(hindsightClient),recall:hindsightClient.recall.bind(hindsightClient),reflect:hindsightClient.reflect.bind(hindsightClient),async getOperationStatus(bankId,operationId){const response=await fetch(`${hindsightUrl}/v1/default/banks/${encodeURIComponent(bankId)}/operations/${encodeURIComponent(operationId)}`,{headers:hindsightApiKey?{Authorization:`Bearer ${hindsightApiKey}`}:{},signal:AbortSignal.timeout(8000)});if(!response.ok)throw new Error(`Hindsight operation status HTTP ${response.status}`);return response.json();}};
const provider=new dlfm.HindsightMemoryAdapter({client:hindsightPort,banks,adapterVersion:process.env.DLMF_DLS_HINDSIGHT_ADAPTER_VERSION||"dls-hindsight-v1",providerVersion:String(version.api_version||version.version||"unknown"),recallBudget:"mid",reflectBudget:"mid",distillationProjectionMode:process.env.DLMF_DLS_HINDSIGHT_DISTILLATION_PROJECTION_MODE||"source_actor_only",asyncRetainTimeoutMs:Number(process.env.DLMF_DLS_HINDSIGHT_ASYNC_TIMEOUT_MS||1_800_000)});
const retrievalPort=new dlfm.HindsightCanonicalProjectionPort({client:hindsightPort,banks,providerId:"hindsight",recallBudget:"mid"});
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:2,connectionTimeoutMillis:5000});
try {
 const state=await inspectDigitalLifeStackSchema(pool); if(!state.ready) throw new Error(`DLMF schema not ready: ${state.state}`);
 const runtime=dlfm.createDigitalLifeStackDlmfRuntime({pool,archiveRoot,bearerToken:process.env.DLMF_DLS_BEARER_TOKEN||"incremental-worker-internal-token-000000000000",agentId:process.env.DLMF_DLS_AGENT_ID||"digital-life-stack",runtimeId:"hermes-incremental",policies:{distillationPolicyVersion:process.env.DLMF_DLS_DISTILLATION_POLICY||"dls-distill-v1",canonicalizationPolicyVersion:process.env.DLMF_DLS_CANONICALIZATION_POLICY||"dls-canonical-v1",admissionPolicyVersion:process.env.DLMF_DLS_ADMISSION_POLICY||"dls-admission-v1",retentionPolicyVersion:process.env.DLMF_DLS_RETENTION_POLICY||"dls-retention-v1"},distillationProvider:provider,retrievalPort});
 const incrementalScope={tenantId:required("DLMF_HERMES_TENANT_ID"),lifeDid:required("DLMF_HERMES_LIFE_DID"),memoryNamespace:required("DLMF_HERMES_MEMORY_NAMESPACE")};
 const sync=new dlfm.HermesIncrementalSyncService({reader:new dlfm.HermesSqliteReader(dbPath),checkpointStore:new dlfm.FileHermesIncrementalCheckpointStore(checkpointPath),ingestor:runtime.createNormalizedExperienceIngestor(incrementalScope),scope:{tenantId:required("DLMF_HERMES_TENANT_ID"),lifeDid:required("DLMF_HERMES_LIFE_DID"),memoryNamespace:required("DLMF_HERMES_MEMORY_NAMESPACE")},origin:{lifeDid:required("DLMF_HERMES_LIFE_DID"),agentId:process.env.DLMF_DLS_AGENT_ID||"digital-life-stack",runtimeId:"hermes-incremental"},policies:{distillationPolicyVersion:process.env.DLMF_DLS_DISTILLATION_POLICY||"dls-distill-v1",canonicalizationPolicyVersion:process.env.DLMF_DLS_CANONICALIZATION_POLICY||"dls-canonical-v1",admissionPolicyVersion:process.env.DLMF_DLS_ADMISSION_POLICY||"dls-admission-v1",retentionPolicyVersion:process.env.DLMF_DLS_RETENTION_POLICY||"dls-retention-v1"},pageSize:Number(process.env.DLMF_HERMES_INCREMENTAL_PAGE_SIZE||250)});
 const baseline=process.argv.includes("--baseline-current");
 const result=baseline?await sync.baselineCurrent():await sync.runOnce();
 if (developmentExperienceJournal !== undefined && result.experiences.length > 0) {
  const lines=result.experiences.map((reference)=>JSON.stringify(reference)).join("\n")+"\n";
  await appendFile(developmentExperienceJournal,lines,{encoding:"utf8",mode:0o600});
 }
 const failedReceipts=result.receipts.filter((receipt)=>receipt.status!=="complete"&&receipt.status!=="awaiting_review").length;
 const status=failedReceipts===0?"PASS":"FAIL";
 console.log(`DLMF_HERMES_INCREMENTAL=${status} mode=${baseline?"baseline":"incremental"} scanned=${result.scanned} changed=${result.changed} ingested=${result.ingested} skipped=${result.skipped} unchanged=${result.unchanged} developmentRefs=${result.experiences.length} failedReceipts=${failedReceipts}`);
 await runtime.close();
 if(failedReceipts>0) process.exitCode=1;
} finally { await pool.end().catch(()=>{}); }
function required(name){const v=process.env[name];if(!v?.trim())throw new Error(`${name} is required`);return v.trim();}
function resolveHindsightApiKey(){
 const explicit=process.env.DLMF_DLS_HINDSIGHT_API_KEY?.trim(); if(explicit) return explicit;
 const hermesHome=resolve(process.env.HERMES_HOME||join(homedir(),".hermes"));
 const envPath=join(hermesHome,".env"); if(!existsSync(envPath)) return undefined;
 for(const raw of readFileSync(envPath,"utf8").split(/\r?\n/u)){
  let line=raw.trim(); if(!line||line.startsWith("#")) continue; if(line.startsWith("export ")) line=line.slice(7);
  const i=line.indexOf("="); if(i<1) continue; const key=line.slice(0,i).trim(); if(key!=="HINDSIGHT_API_KEY") continue;
  let value=line.slice(i+1).trim(); if(value.length>=2&&value[0]===value.at(-1)&&["'",'"'].includes(value[0])) value=value.slice(1,-1);
  return value.trim()||undefined;
 }
 return undefined;
}
async function assertHindsightAuthentication(baseUrl,apiKey){
 const response=await fetch(`${baseUrl}/v1/default/banks?limit=1`,{headers:apiKey?{Authorization:`Bearer ${apiKey}`}:{},signal:AbortSignal.timeout(8000)});
 if(!response.ok) throw new Error(`Hindsight authentication probe failed HTTP ${response.status}`);
}
