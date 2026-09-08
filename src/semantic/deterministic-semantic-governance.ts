import type {
  EpistemicStatus,
  MemoryRevision,
  MemoryType,
  SemanticRelation,
  SpeakerProvenance,
} from "../domain/types.js";
import { sha256 } from "../domain/utils.js";
import type { ProviderMemoryUnit } from "../distillation/types.js";

export type SemanticPolarity = "affirmative" | "negative" | "unknown";

export interface SemanticClassification {
  memoryType: MemoryType;
  speakerProvenance: SpeakerProvenance;
  epistemicStatus: EpistemicStatus;
  semanticKey: string;
  semanticPolarity: SemanticPolarity;
  attributionBasis: "dlmf_semantic_policy";
  reasonCodes: string[];
}

export interface SemanticMemoryGovernance {
  readonly policyVersion: string;
  classify(unit: ProviderMemoryUnit): SemanticClassification;
  relate(unit: ProviderMemoryUnit, current: MemoryRevision): SemanticRelation;
}

interface RecognizedConcept {
  id: string;
  key: string;
}

const technicalPattern = /\b(?:api|database|function|script|service|tool|https|shell|floating[- ]point|error|bug|code|session\.py|review found)\b|技術|程式|服務|資料庫|浮點|錯誤|審查/i;
const transientPattern = /\b(?:currently|current progress|score|moves?|in progress|right now)\b|目前|當前|進度|分數|步數/i;
const projectPattern = /\b(?:added|installed|download(?:ed| failures?)?|verified|not added|replaced|blocked|completed|deployed)\b|已加入|未加入|下載失敗|已驗證|完成|阻塞/i;
const preferencePattern = /\b(?:prefers?|preference|likes?|dislikes?|would rather|requires?|wants?)\b|偏好|比較喜歡|更喜歡|不喜歡|喜歡|要求|希望/i;
const liveCommentaryPattern = /nancy|live|stream|commentary|實況|直播|操作|吐槽|反應/i;
const inlinePattern = /inline|interleav|threaded|interspers|within|directly|穿插|交錯|直接/i;
const narrativePattern = /story|stories|narrative|novel|episode|section|故事|小說|情節|段落/i;
const positiveInlinePreferencePattern = /\b(?:prefers?|requires?|must)\b[^.!?]{0,220}(?:inline|interleav|threaded|interspers)|(?:偏好|要求|必須)[^。！？]{0,220}(?:穿插|交錯|直接)/i;
const negativeInlinePreferencePattern = /\b(?:dislikes?|hates?|avoids?|rejects?)\b[^.!?]{0,48}(?:inline|interleav|threaded|interspers)|不(?:喜歡|要|應該)[^。！？]{0,24}(?:穿插|交錯|直接)/i;
const generalNegativePattern = /\b(?:does not prefer|doesn't prefer|dislikes?|hates?|avoids?|rejects?|must not|should not|not)\b|不喜歡|不偏好|不要|反對|不得|不應/i;
const generalPositivePattern = /\b(?:prefers?|likes?|requires?|wants?|must|should)\b|偏好|喜歡|要求|希望|必須|應該/i;

const aliases: ReadonlyArray<readonly [RegExp, string]> = [
  [/深色模式|暗色模式|dark\s+mode/giu, " dark_mode "],
  [/所有(?:裝置|設備)|全部(?:裝置|設備)|all\s+devices?|every\s+device/giu, " all_devices "],
  [/通知|notifications?/giu, " notifications "],
  [/即時反應|real[- ]time\s+reactions?/giu, " realtime_reaction "],
  [/實況|直播|live\s+stream(?:ing)?/giu, " live_stream "],
  [/穿插|交錯|inline|interleav\w*|threaded|interspers\w*/giu, " inline_interleave "],
  [/故事|小說|情節|story|stories|narrative|novel/giu, " narrative "],
  [/分段|separate[ds]?|end[- ]of[- ](?:episode|section)/giu, " separated "],
  [/用戶|使用者|user/giu, " "],
  [/偏好|比較喜歡|更喜歡|喜歡|不喜歡|要求|希望/giu, " "],
  [/prefers?|preference|likes?|dislikes?|requires?|wants?/giu, " "],
];

const stopTokens = new Set([
  "a", "an", "and", "as", "at", "be", "by", "for", "from", "in", "is", "it",
  "of", "on", "or", "rather", "such", "than", "that", "the", "their", "this", "to",
  "where", "with", "within", "would",
]);

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalizedText(value: string): string {
  let canonical = value.normalize("NFKC").toLocaleLowerCase("en-US");
  for (const [pattern, replacement] of aliases) canonical = canonical.replace(pattern, replacement);
  return canonical.replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function semanticTokens(value: string): Set<string> {
  return new Set(
    canonicalizedText(value)
      .split(" ")
      .filter((token) => token.length > 1 && !stopTokens.has(token)),
  );
}

function inferredMemoryType(unit: ProviderMemoryUnit): MemoryType {
  switch (unit.candidateType) {
    case "preference_candidate":
      return "preference";
    case "relationship_candidate":
      return "relationship";
    case "project_state_candidate":
      return "project_state";
    case "commitment_candidate":
      return "commitment";
    case "habit_candidate":
      return "habit";
    case "event_candidate":
      return transientPattern.test(unit.proposedContent.text) ? "transient_state" : "event";
    default:
      break;
  }

  const text = unit.proposedContent.text;
  if (transientPattern.test(text)) return "transient_state";
  if (technicalPattern.test(text)) return "technical_fact";
  if (projectPattern.test(text)) return "project_state";
  if (preferencePattern.test(text)) return "preference";
  return "general_fact";
}

function inferredSpeaker(unit: ProviderMemoryUnit): SpeakerProvenance {
  if (unit.speakerProvenance !== undefined) return unit.speakerProvenance;
  if (unit.producer.kind === "user") return "user";
  if (unit.producer.kind === "system") return "system";
  return "unknown";
}

function attributedStatus(
  unit: ProviderMemoryUnit,
  memoryType: MemoryType,
  speaker: SpeakerProvenance,
): EpistemicStatus {
  const status = unit.epistemicStatus;
  if (status === "inferred" || status === "synthesized" || status === "uncertain") return status;
  if (status === "user_asserted") {
    return speaker === "user" &&
      (memoryType === "preference" || memoryType === "habit" || memoryType === "relationship")
      ? "user_asserted"
      : "uncertain";
  }
  if (status === "system_observed") {
    return speaker === "system" || speaker === "tool" ? "system_observed" : "uncertain";
  }
  return speaker === "system" || speaker === "tool" ? "observed" : "uncertain";
}

function recognizedConcept(
  text: string,
  memoryType: MemoryType,
  speakerProvenance: SpeakerProvenance,
): RecognizedConcept | undefined {
  if (memoryType !== "preference" || speakerProvenance !== "user") return undefined;
  if (
    liveCommentaryPattern.test(text) &&
    inlinePattern.test(text) &&
    narrativePattern.test(text)
  ) {
    return {
      id: "nancy_live_commentary_placement",
      key: "preference:user:story_stream_structure:nancy_live_commentary_placement",
    };
  }
  if (/dark\s+mode|深色模式|暗色模式/i.test(text)) {
    return { id: "dark_mode", key: "preference:user:display:dark_mode" };
  }
  if (/notifications?|通知/i.test(text)) {
    return { id: "notifications", key: "preference:user:notifications" };
  }
  return undefined;
}

function polarityFor(text: string, concept: RecognizedConcept | undefined): SemanticPolarity {
  if (concept?.id === "nancy_live_commentary_placement") {
    const positive = positiveInlinePreferencePattern.test(text);
    const negative = negativeInlinePreferencePattern.test(text);
    if (positive === negative) return "unknown";
    return positive ? "affirmative" : "negative";
  }
  const negative = generalNegativePattern.test(text);
  const positive = generalPositivePattern.test(text);
  if (negative && positive) return "unknown";
  if (negative) return "negative";
  return "affirmative";
}

function semanticKeyFor(
  unit: ProviderMemoryUnit,
  memoryType: MemoryType,
  speakerProvenance: SpeakerProvenance,
): { semanticKey: string; concept?: RecognizedConcept } {
  const concept = recognizedConcept(unit.proposedContent.text, memoryType, speakerProvenance);
  if (concept !== undefined) return { semanticKey: concept.key, concept };
  return {
    semanticKey: `semantic:${sha256({
      memoryType,
      memoryKind: unit.memoryKind,
      text: normalizeText(unit.proposedContent.text),
    }).slice("sha256:".length)}`,
  };
}

function isSubset(left: Set<string>, right: Set<string>): boolean {
  return [...left].every((token) => right.has(token));
}

export class DeterministicSemanticMemoryGovernance implements SemanticMemoryGovernance {
  constructor(readonly policyVersion = "dlmf-semantic-v2") {}

  classify(unit: ProviderMemoryUnit): SemanticClassification {
    const memoryType = inferredMemoryType(unit);
    const speakerProvenance = inferredSpeaker(unit);
    const epistemicStatus = attributedStatus(unit, memoryType, speakerProvenance);
    const { semanticKey, concept } = semanticKeyFor(unit, memoryType, speakerProvenance);
    const semanticPolarity = polarityFor(unit.proposedContent.text, concept);
    return {
      memoryType,
      speakerProvenance,
      epistemicStatus,
      semanticKey,
      semanticPolarity,
      attributionBasis: "dlmf_semantic_policy",
      reasonCodes: [
        `semantic:memory_type:${memoryType}`,
        `semantic:speaker_provenance:${speakerProvenance}`,
        `semantic:epistemic_status:${epistemicStatus}`,
        `semantic:polarity:${semanticPolarity}`,
        ...(concept === undefined ? [] : [`semantic:concept:${concept.id}`]),
      ],
    };
  }

  relate(unit: ProviderMemoryUnit, current: MemoryRevision): SemanticRelation {
    if (unit.semanticKey !== current.semanticKey) {
      throw new Error("semantic relation requires an identical DLMF semantic key");
    }
    const candidateType = unit.memoryType ?? inferredMemoryType(unit);
    const candidateSpeaker = unit.speakerProvenance ?? inferredSpeaker(unit);
    const candidateConcept = recognizedConcept(
      unit.proposedContent.text,
      candidateType,
      candidateSpeaker,
    );
    const currentConcept = recognizedConcept(
      current.canonicalContent.text,
      current.memoryType,
      current.speakerProvenance,
    );
    const candidatePolarity = polarityFor(unit.proposedContent.text, candidateConcept);
    const existingPolarity = polarityFor(current.canonicalContent.text, currentConcept);
    if (candidatePolarity === "unknown" || existingPolarity === "unknown") return "unrelated";
    if (candidatePolarity !== existingPolarity) return "contradicts";

    const candidate = semanticTokens(unit.proposedContent.text);
    const existing = semanticTokens(current.canonicalContent.text);
    if (isSubset(candidate, existing) && !isSubset(existing, candidate)) {
      return "existing_subsumes_candidate";
    }
    if (isSubset(existing, candidate) && !isSubset(candidate, existing)) {
      return "candidate_subsumes_existing";
    }
    return "equivalent";
  }
}
