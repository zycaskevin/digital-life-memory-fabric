import type {
  DistillationRequest,
  DistillationResult,
  MemoryEvidence,
  RecallRequest,
  ReflectRequest,
  ReflectResult,
} from "./types.js";

export interface MemoryDistillationProvider {
  readonly name: string;
  readonly adapterVersion: string;
  readonly providerVersion: string | undefined;

  distill(request: DistillationRequest): Promise<DistillationResult>;
  recall(request: RecallRequest): Promise<MemoryEvidence[]>;
  reflect(request: ReflectRequest): Promise<ReflectResult>;
}
