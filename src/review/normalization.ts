/** Order-preserving normalization for governed review reason/evidence identifiers. */
export function normalizeSemanticReviewIdentifiers(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()))].filter(Boolean);
}
