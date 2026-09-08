import { ValidationError } from "../domain/errors.js";
import type { ReflectiveInsightStore } from "./reflective-insight-store.js";
import type { ReflectiveInsight, ReflectiveInsightId } from "./types.js";

const clone = <T>(value: T): T => structuredClone(value);

export class InMemoryReflectiveInsightStore implements ReflectiveInsightStore {
  private readonly insights = new Map<ReflectiveInsightId, ReflectiveInsight>();

  async put(insight: ReflectiveInsight): Promise<void> {
    if (insight.canonicalWritePerformed !== false) {
      throw new ValidationError("reflective insights cannot perform canonical writes");
    }
    this.insights.set(insight.insightId, clone(insight));
  }

  async get(insightId: ReflectiveInsightId): Promise<ReflectiveInsight | undefined> {
    const insight = this.insights.get(insightId);
    return insight === undefined ? undefined : clone(insight);
  }
}
