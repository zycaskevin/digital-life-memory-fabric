import { createHash, randomUUID } from "node:crypto";
import type {
  CandidateId,
  ConflictId,
  EventId,
  MemoryId,
  MemoryScope,
  OutboxId,
} from "./types.js";

export interface Clock {
  now(): string;
}

export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}

export interface IdFactory {
  candidateId(): CandidateId;
  memoryId(): MemoryId;
  eventId(): EventId;
  outboxId(): OutboxId;
  conflictId(): ConflictId;
}

const suffix = (): string => randomUUID().replaceAll("-", "");

export class RandomIdFactory implements IdFactory {
  candidateId(): CandidateId {
    return `cand_${suffix()}`;
  }

  memoryId(): MemoryId {
    return `mem_${suffix()}`;
  }

  eventId(): EventId {
    return `evt_${suffix()}`;
  }

  outboxId(): OutboxId {
    return `out_${suffix()}`;
  }

  conflictId(): ConflictId {
    return `conf_${suffix()}`;
  }
}

export function scopeKey(scope: MemoryScope): string {
  return `${scope.tenantId}\u001f${scope.lifeDid}\u001f${scope.memoryNamespace}`;
}

export function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  return scopeKey(left) === scopeKey(right);
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }

  if (value !== null && typeof value === "object") {
    const input = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(input)
        .sort()
        .map((key) => [key, normalize(input[key])]),
    );
  }

  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}
