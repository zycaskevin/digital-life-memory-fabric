#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { inspectDigitalLifeStackSchema, validatedDlmfSchema } from "./digital-life-stack-schema-lib.mjs";

const dlfm = await import(new URL("../dist/index.js", import.meta.url));
const dbPath = resolve(required("DLMF_HERMES_STATE_DB"));
const checkpointPath = resolve(required("DLMF_HERMES_INCREMENTAL_CHECKPOINT"));
await mkdir(dirname(checkpointPath), { recursive: true });
const databaseUrl = required("DLMF_DLS_DATABASE_URL");
const schema = validatedDlmfSchema(process.env.DLMF_DLS_SCHEMA || "dlmf_digital_life_stack");
const archiveRoot = resolve(required("DLMF_DLS_ARCHIVE_ROOT"));
const hindsightUrl = required("DLMF_DLS_HINDSIGHT_URL");
const omniHarnessDir = resolve(process.env.OMNIHARNESS_DIR || resolve("../OmniHarness"));
const clientModule = process.env.DLMF_DLS_HINDSIGHT_CLIENT_MODULE ? resolve(process.env.DLMF_DLS_HINDSIGHT_CLIENT_MODULE) : resolve(omniHarnessDir,"node_modules","@vectorize-io","hindsight-client","dist","index.mjs");
if (!existsSync(clientModule)) throw new Error("Hindsight client module not found");
const { HindsightClient } = await import(pathToFileURL(clientModule).href);
const hindsightClient = new HindsightClient({baseUrl:hindsightUrl,...(process.env.DLMF_DLS_HINDSIGHT_API_KEY?.trim()?{apiKey:process.env.DLMF_DLS_HINDSIGHT_API_KEY.trim()}:{})});
const version=await hindsightClient.getVersion();
const banks=new dlfm.DeterministicHindsightPlaneResolver(process.env.DLMF_DLS_HINDSIGHT_BANK_PREFIX||"dlmf-dls");
const hindsightPort={retain:hindsightClient.retain.bind(hindsightClient),listMemories:hindsightClient.listMemories.bind(hindsightClient),recall:hindsightClient.recall.bind(hindsightClient),reflect:hindsightClient.reflect.bind(hindsightClient),async getOperationStatus(bankId,operationId){const response=await fetch(`${hindsightUrl}/v1/default/banks/${encodeURIComponent(bankId)}/operations/${encodeURIComponent(operationId)}`,{headers:process.env.DLMF_DLS_HINDSIGHT_API_KEY?.trim()?{Authorization:`Bearer ${process.env.DLMF_DLS_HINDSIGHT_API_KEY.trim()}`}:{},signal:AbortSignal.timeout(8000)});if(!response.ok)throw new Error(`Hindsight operation status HTTP ${response.status}`);return response.json();}};
const provider=new dlfm.HindsightMemoryAdapter({client:hindsightPort,banks,adapterVersion:process.env.DLMF_DLS_HINDSIGHT_ADAPTER_VERSION||"dls-hindsight-v1",providerVersion:String(version.api_version||version.version||"unknown"),recallBudget:"mid",reflectBudget:"mid"});
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:2,connectionTimeoutMillis:5000});
try {
 const state=await inspectDigitalLifeStackSchema(pool); if(!state.ready) throw new Error(`DLMF schema not ready: ${state.state}`);
 const runtime=dlfm.createDigitalLifeStackDlmfRuntime({pool,archiveRoot,bearerToken:process.env.DLMF_DLS_BEARER_TOKEN||"incremental-worker-internal-token-000000000000",agentId:process.env.DLMF_DLS_AGENT_ID||"digital-life-stack",runtimeId:"hermes-incremental",policies:{distillationPolicyVersion:process.env.DLMF_DLS_DISTILLATION_POLICY||"dls-distill-v1",canonicalizationPolicyVersion:process.env.DLMF_DLS_CANONICALIZATION_POLICY||"dls-canonical-v1",admissionPolicyVersion:process.env.DLMF_DLS_ADMISSION_POLICY||"dls-admission-v1",retentionPolicyVersion:process.env.DLMF_DLS_RETENTION_POLICY||"dls-retention-v1"},distillationProvider:provider,retrievalPort:{async search(){return {providerId:"unused",candidates:[]}}}});
 const incrementalScope={tenantId:required("DLMF_HERMES_TENANT_ID"),lifeDid:required("DLMF_HERMES_LIFE_DID"),memoryNamespace:required("DLMF_HERMES_MEMORY_NAMESPACE")};
 const sync=new dlfm.HermesIncrementalSyncService({reader:new dlfm.HermesSqliteReader(dbPath),checkpointStore:new dlfm.FileHermesIncrementalCheckpointStore(checkpointPath),ingestor:runtime.createNormalizedExperienceIngestor(incrementalScope),scope:{tenantId:required("DLMF_HERMES_TENANT_ID"),lifeDid:required("DLMF_HERMES_LIFE_DID"),memoryNamespace:required("DLMF_HERMES_MEMORY_NAMESPACE")},origin:{lifeDid:required("DLMF_HERMES_LIFE_DID"),agentId:process.env.DLMF_DLS_AGENT_ID||"digital-life-stack",runtimeId:"hermes-incremental"},policies:{distillationPolicyVersion:process.env.DLMF_DLS_DISTILLATION_POLICY||"dls-distill-v1",canonicalizationPolicyVersion:process.env.DLMF_DLS_CANONICALIZATION_POLICY||"dls-canonical-v1",admissionPolicyVersion:process.env.DLMF_DLS_ADMISSION_POLICY||"dls-admission-v1",retentionPolicyVersion:process.env.DLMF_DLS_RETENTION_POLICY||"dls-retention-v1"},pageSize:Number(process.env.DLMF_HERMES_INCREMENTAL_PAGE_SIZE||250)});
 const baseline=process.argv.includes("--baseline-current");
 const result=baseline?await sync.baselineCurrent():await sync.runOnce();
 const failedReceipts=result.receipts.filter((receipt)=>receipt.status!=="complete"&&receipt.status!=="awaiting_review").length;
 const status=failedReceipts===0?"PASS":"FAIL";
 console.log(`DLMF_HERMES_INCREMENTAL=${status} mode=${baseline?"baseline":"incremental"} scanned=${result.scanned} changed=${result.changed} ingested=${result.ingested} unchanged=${result.unchanged} failedReceipts=${failedReceipts}`);
 await runtime.close();
 if(failedReceipts>0) process.exitCode=1;
} finally { await pool.end().catch(()=>{}); }
function required(name){const v=process.env[name];if(!v?.trim())throw new Error(`${name} is required`);return v.trim();}
