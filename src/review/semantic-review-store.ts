import type { MemoryScope } from "../domain/types.js";
import type {
  SemanticReviewCase,
  SemanticReviewCaseId,
  SemanticReviewEvent,
  SemanticReviewListOptions,
} from "./types.js";

export interface SemanticReviewStore {
  enqueue(reviewCase: SemanticReviewCase, event: SemanticReviewEvent): Promise<SemanticReviewCase>;
  get(scope: MemoryScope, caseId: SemanticReviewCaseId): Promise<SemanticReviewCase | undefined>;
  listByReceipt(scope: MemoryScope, receiptId: string): Promise<SemanticReviewCase[]>;
  list(scope: MemoryScope, options?: SemanticReviewListOptions): Promise<SemanticReviewCase[]>;
  getEventByIdempotencyKey(
    scope: MemoryScope,
    idempotencyKey: string,
  ): Promise<SemanticReviewEvent | undefined>;
  resolve(
    caseId: SemanticReviewCaseId,
    expectedVersion: number,
    next: SemanticReviewCase,
    event: SemanticReviewEvent,
  ): Promise<SemanticReviewCase>;
  listEvents(scope: MemoryScope, caseId: SemanticReviewCaseId): Promise<SemanticReviewEvent[]>;
}
