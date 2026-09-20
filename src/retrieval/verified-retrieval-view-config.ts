import { ValidationError } from "../domain/errors.js";
import type { MemoryScope } from "../domain/types.js";
import { sameScope } from "../domain/utils.js";

export const VERIFIED_RETRIEVAL_VIEW_CONFIG_SCHEMA = "dlmf.verified-retrieval-view.v1";
const MAX_MOUNTS = 8;

export interface VerifiedRetrievalViewMountConfig {
  readonly mountId: string;
  readonly schema: string;
  readonly scope: MemoryScope;
  readonly hindsightBankPrefix: string;
  readonly mode: "read_only_historical";
}

export interface VerifiedRetrievalViewConfig {
  readonly schema: typeof VERIFIED_RETRIEVAL_VIEW_CONFIG_SCHEMA;
  readonly viewId: string;
  readonly publicScope: MemoryScope;
  readonly mounts: readonly VerifiedRetrievalViewMountConfig[];
}

export function validateVerifiedRetrievalViewConfig(
  value: unknown,
  expectedPublicScope?: MemoryScope,
): VerifiedRetrievalViewConfig {
  const root = object(value, "memory view config");
  exactKeys(root, ["schema", "viewId", "publicScope", "mounts"], "memory view config");
  if (root.schema !== VERIFIED_RETRIEVAL_VIEW_CONFIG_SCHEMA) {
    throw new ValidationError("unsupported memory view config schema");
  }
  const viewId = identifier(root.viewId, "viewId");
  const publicScope = scope(root.publicScope, "publicScope");
  if (expectedPublicScope !== undefined && !sameScope(publicScope, expectedPublicScope)) {
    throw new ValidationError("memory view publicScope must match the bound DLMF scope");
  }
  if (!Array.isArray(root.mounts) || root.mounts.length < 1 || root.mounts.length > MAX_MOUNTS) {
    throw new ValidationError(`memory view mounts must contain 1..${MAX_MOUNTS} entries`);
  }

  const mountIds = new Set<string>();
  const scopeKeys = new Set<string>();
  const mounts = root.mounts.map((raw, index) => {
    const entry = object(raw, `mounts[${index}]`);
    exactKeys(
      entry,
      ["mountId", "schema", "scope", "hindsightBankPrefix", "mode"],
      `mounts[${index}]`,
    );
    const mountId = identifier(entry.mountId, `mounts[${index}].mountId`);
    if (mountIds.has(mountId)) throw new ValidationError("memory view mountId must be unique");
    mountIds.add(mountId);
    const mountScope = scope(entry.scope, `mounts[${index}].scope`);
    if (mountScope.lifeDid !== publicScope.lifeDid) {
      throw new ValidationError("memory view mount lifeDid must match publicScope");
    }
    if (sameScope(mountScope, publicScope)) {
      throw new ValidationError("memory view mount must not duplicate publicScope");
    }
    const scopeIdentity = scopeKey(mountScope);
    if (scopeKeys.has(scopeIdentity)) {
      throw new ValidationError("memory view mount scope must be unique");
    }
    scopeKeys.add(scopeIdentity);
    const schema = identifier(entry.schema, `mounts[${index}].schema`, 63);
    if (!/^dlmf_[a-z0-9_]+$/u.test(schema)) {
      throw new ValidationError("memory view mount schema must be a dlmf_* identifier");
    }
    const hindsightBankPrefix = identifier(
      entry.hindsightBankPrefix,
      `mounts[${index}].hindsightBankPrefix`,
      128,
    );
    if (entry.mode !== "read_only_historical") {
      throw new ValidationError("memory view mount mode must be read_only_historical");
    }
    return {
      mountId,
      schema,
      scope: mountScope,
      hindsightBankPrefix,
      mode: "read_only_historical" as const,
    };
  });

  return {
    schema: VERIFIED_RETRIEVAL_VIEW_CONFIG_SCHEMA,
    viewId,
    publicScope,
    mounts,
  };
}

function scope(value: unknown, label: string): MemoryScope {
  const input = object(value, label);
  exactKeys(input, ["tenantId", "lifeDid", "memoryNamespace"], label);
  return {
    tenantId: text(input.tenantId, `${label}.tenantId`, 256),
    lifeDid: text(input.lifeDid, `${label}.lifeDid`, 256),
    memoryNamespace: text(input.memoryNamespace, `${label}.memoryNamespace`, 512),
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new ValidationError(`${label} has unsupported or missing fields`);
  }
}

function identifier(value: unknown, label: string, max = 128): string {
  const result = text(value, label, max);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(result)) {
    throw new ValidationError(`${label} must be a bounded identifier`);
  }
  return result;
}

function text(value: unknown, label: string, max: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > max
    || value !== value.trim()
    || /[\u0000\r\n]/u.test(value)
  ) {
    throw new ValidationError(`${label} invalid`);
  }
  return value;
}

function scopeKey(value: MemoryScope): string {
  return `${value.tenantId}\u001f${value.lifeDid}\u001f${value.memoryNamespace}`;
}
