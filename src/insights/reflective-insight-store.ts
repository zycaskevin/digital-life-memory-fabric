import type { ReflectiveInsight, ReflectiveInsightId } from "./types.js";

export interface ReflectiveInsightStore {
  put(insight: ReflectiveInsight): Promise<void>;
  get(insightId: ReflectiveInsightId): Promise<ReflectiveInsight | undefined>;
}
