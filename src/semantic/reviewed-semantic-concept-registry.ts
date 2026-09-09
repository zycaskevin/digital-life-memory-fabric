import type { MemoryType, SpeakerProvenance } from "../domain/types.js";
import {
  hasExplicitPreferenceAssertion,
  isNancyInlinePreferenceFamily,
} from "./memory-language-signals.js";

export type SemanticPolarity = "affirmative" | "negative" | "unknown";

export interface ReviewedSemanticConcept {
  id: string;
  key: string;
  /**
   * Only a specifically reviewed paraphrase family may merge incomparable
   * normalized token sets. All other registered concepts fail closed.
   */
  allowIncomparableEquivalent: boolean;
}

export interface SemanticConceptResolution {
  concept?: ReviewedSemanticConcept;
  matchedConceptIds: string[];
}

interface ConceptDefinition extends ReviewedSemanticConcept {
  matches(text: string): boolean;
  polarity?(text: string): SemanticPolarity;
}

const explicitNegativePreferencePattern =
  /\b(?:does\s+not|doesn't|do\s+not|don't)\s+(?:prefer|like|want|require)\b|\b(?:prefers?|wants?|requires?)\b[^.!?]{0,60}\b(?:no|without)\b|\b(?:dislikes?|rejects?|avoids?)\b|不偏好|不喜歡|不要|拒絕|反對/i;
const explicitPositivePreferencePattern =
  /\b(?:prefers?|preference|likes?|requires?|wants?)\b|偏好|喜歡|要求|希望/i;
const negatedPreferenceExpression =
  /\b(?:does\s+not|doesn't|do\s+not|don't)\s+(?:prefer|like|want|require)\b|\b(?:prefers?|wants?|requires?)\b[^.!?]{0,60}\b(?:no|without)\b|不偏好|不喜歡|不要/giu;
const qualifierExceptionPattern =
  /\b(?:but|however|except|excluding)\b|但|可是|不過|除了|排除/i;

const positiveInlinePreferencePattern =
  /\b(?:prefers?|requires?|must|should)\b[^.!?]{0,220}(?:inline|interleav|threaded|interspers|directly|within)|(?:偏好|要求|必須|應該|需要)[^。！？]{0,220}(?:穿插|交錯|直接|正文)/i;
const negativeInlinePreferencePattern =
  /\b(?:dislikes?|hates?|avoids?|rejects?)\b[^.!?]{0,80}(?:inline|interleav|threaded|interspers)|\b(?:prefers?|wants?|requires?)\b[^.!?]{0,80}\b(?:no|without)\b[^.!?]{0,80}(?:inline|interleav|threaded|interspers)|不(?:喜歡|要|應該)[^。！？]{0,48}(?:穿插|交錯|直接)/i;
const normativeNegativeInlinePattern =
  /\b(?:(?:must|should)(?:\s+not|n't)|can\s+not|cannot|can't)\b[^.!?]{0,120}(?:inline|interleav|threaded|interspers)|(?:不得|不應該|不應|不可)[^。！？]{0,120}(?:穿插|交錯|直接)/i;
const explicitSeparatePreferencePattern =
  /\b(?:prefers?|requires?|wants?)\b[^.!?]{0,100}(?:separate[ds]?|end[- ]of[- ](?:episode|section))|(?:偏好|要求|希望)[^。！？]{0,100}(?:分段|獨立實況|章末實況)/i;
const placementContrastPattern = /\brather\s+than\b|\binstead\s+of\b|而非|而不是|而不|不是/i;

function genericPreferencePolarity(text: string): SemanticPolarity {
  if (qualifierExceptionPattern.test(text)) return "unknown";
  const negative = explicitNegativePreferencePattern.test(text);
  const positiveRemainder = text.replace(negatedPreferenceExpression, " ");
  const positive = explicitPositivePreferencePattern.test(positiveRemainder);
  if (negative && positive) return "unknown";
  if (negative) return "negative";
  if (positive) return "affirmative";
  return "unknown";
}

function nancyPlacementPolarity(text: string): SemanticPolarity {
  if (qualifierExceptionPattern.test(text)) return "unknown";
  const positive = positiveInlinePreferencePattern.test(text);
  const negativeInline = negativeInlinePreferencePattern.test(text);
  if (normativeNegativeInlinePattern.test(text)) return "negative";
  if (negativeInline) return "negative";
  const separate = explicitSeparatePreferencePattern.test(text);
  if (positive && separate && !placementContrastPattern.test(text)) return "unknown";
  if (positive) return "affirmative";
  if (separate) return "negative";
  return "unknown";
}

function explicitPreferenceWith(text: string, pattern: RegExp): boolean {
  return hasExplicitPreferenceAssertion(text) && pattern.test(text);
}

/**
 * DLMF-owned allow-list. Adding or broadening a family requires source review,
 * regression fixtures, and a semantic policy version change. Provider output
 * cannot register concepts at runtime.
 */
const definitions: readonly ConceptDefinition[] = [
  {
    id: "nancy_live_commentary_placement",
    key: "preference:user:story_stream_structure:nancy_live_commentary_placement",
    allowIncomparableEquivalent: true,
    matches: isNancyInlinePreferenceFamily,
    polarity: nancyPlacementPolarity,
  },
  {
    id: "generation_routing_8b",
    key: "preference:user:model_routing:generation:8b",
    allowIncomparableEquivalent: false,
    matches: (text) => explicitPreferenceWith(
      text,
      /\b8b\b[\s\S]{0,100}(?:generation\s*(?:route|routing|路由)|生成(?:模型)?路由)|(?:generation\s*(?:route|routing|路由)|生成(?:模型)?路由)[\s\S]{0,100}\b8b\b/i,
    ),
  },
  {
    id: "dark_mode",
    key: "preference:user:display:dark_mode",
    allowIncomparableEquivalent: false,
    matches: (text) => explicitPreferenceWith(text, /dark\s+mode|深色模式|暗色模式/i),
  },
  {
    id: "notifications",
    key: "preference:user:notifications",
    allowIncomparableEquivalent: false,
    matches: (text) => explicitPreferenceWith(text, /notifications?|通知/i),
  },
  {
    id: "interaction_language_traditional_chinese",
    key: "preference:user:interaction_language:traditional_chinese",
    allowIncomparableEquivalent: false,
    matches: (text) => explicitPreferenceWith(
      text,
      /traditional\s+chinese|繁體中文|正體中文/i,
    ) && /language|interact|communicat|response|reply|write|speak|語言|互動|溝通|回覆|回答|書寫|口語|使用/i.test(text),
  },
  {
    id: "narrative_third_person",
    key: "preference:user:narrative:third_person",
    allowIncomparableEquivalent: false,
    matches: (text) => explicitPreferenceWith(
      text,
      /third[- ]person|第三人稱/i,
    ) && /story|stories|narrative|novel|writing|style|故事|小說|敘事|寫作|風格/i.test(text),
  },
  {
    id: "short_games_first",
    key: "preference:user:game_order:short_games_first",
    allowIncomparableEquivalent: false,
    matches: (text) => explicitPreferenceWith(
      text,
      /short\s+games?|shorter\s+games?|短(?:篇)?遊戲/i,
    ) && /\b(?:first|before|prioriti\w*|start(?:ing)?\s+with)\b|先行|優先|先玩|開始/i.test(text),
  },
];

export function resolveReviewedSemanticConcept(
  text: string,
  memoryType: MemoryType,
  speakerProvenance: SpeakerProvenance,
): SemanticConceptResolution {
  if (memoryType !== "preference" || speakerProvenance !== "user") {
    return { matchedConceptIds: [] };
  }
  const matches = definitions.filter((definition) => definition.matches(text));
  if (matches.length !== 1) {
    return { matchedConceptIds: matches.map((definition) => definition.id).sort() };
  }
  const definition = matches[0];
  if (definition === undefined) return { matchedConceptIds: [] };
  return {
    concept: {
      id: definition.id,
      key: definition.key,
      allowIncomparableEquivalent: definition.allowIncomparableEquivalent,
    },
    matchedConceptIds: [definition.id],
  };
}

export function polarityForReviewedConcept(
  text: string,
  concept: ReviewedSemanticConcept,
): SemanticPolarity {
  const definition = definitions.find((item) => item.id === concept.id);
  if (definition === undefined) return "unknown";
  return definition.polarity?.(text) ?? genericPreferencePolarity(text);
}

export function reviewedSemanticConceptIds(): readonly string[] {
  return definitions.map((definition) => definition.id);
}
