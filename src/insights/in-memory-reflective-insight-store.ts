import { ValidationError } from "../domain/errors.js";
import { stableStringify } from "../domain/utils.js";
import type { ReflectiveInsightStore } from "./reflective-insight-store.js";
import type { ReflectiveInsight, ReflectiveInsightId } from "./types.js";

const clone = <T>(value: T): T => structuredClone(value);

function immutableState(insight: ReflectiveInsight): string {
  const { status: _status, promotionEligibility: _eligibility, updatedAt: _updatedAt, ...state } =
    insight;
  return stableStringify(state);
}

export class InMemoryReflectiveInsightStore implements ReflectiveInsightStore {
  private readonly insights = new Map<ReflectiveInsightId, ReflectiveInsight>();

  async put(insight: ReflectiveInsight): Promise<void> {
    if (insight.canonicalWritePerformed !== false) {
      throw new ValidationError("reflective insights cannot perform canonical writes");
    }
    const existing = this.insights.get(insight.insightId);
    if (existing !== undefined && immutableState(existing) !== immutableState(insight)) {
      throw new ValidationError("reflective insight write changed immutable fields");
    }
    this.insights.set(insight.insightId, clone(insight));
  }

  async get(insightId: ReflectiveInsightId): Promise<ReflectiveInsight | undefined> {
    const insight = this.insights.get(insightId);
    return insight === undefined ? undefined : clone(insight);
  }
}
