import type {
  EpistemicStatus,
  MemoryRevision,
  MemoryType,
  SemanticRelation,
  SpeakerProvenance,
} from "../domain/types.js";
import { ValidationError } from "../domain/errors.js";
import { sha256 } from "../domain/utils.js";
import type { ProviderMemoryUnit } from "../distillation/types.js";
import {
  hasExplicitPreferenceAssertion,
  isNancyInlinePreferenceFamily,
} from "./memory-language-signals.js";
import {
  polarityForReviewedConcept,
  resolveReviewedSemanticConcept,
  type ReviewedSemanticConcept,
  type SemanticPolarity,
} from "./reviewed-semantic-concept-registry.js";

export type { SemanticPolarity } from "./reviewed-semantic-concept-registry.js";

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

const technicalPattern = /\b(?:api|database|function|script|service|tool|https|shell|floating[- ]point|error|bug|code|session\.py|review|schema|json|permissions?|polic(?:y|ies)|token|credential|time\s+window|execution\s+window|quote\s+window|threshold|constraint)\b|技術|程式|服務|資料庫|浮點|錯誤|審查|權限|規範|憑證|金鑰|密碼|時間窗口|執行時間|秒之間|門檻|限制條件/i;
const transientPattern = /\b(?:currently|current progress|score|moves?|in progress|right now)\b|目前|當前|進度|分數|步數/i;
const completedEventPattern = /\b(?:review|audit|test|migration|deployment)\b[^.!?\n]{0,160}\b(?:was|were|has been|had been)\s+(?:performed|executed|run|completed)\b|(?:已|曾)(?:完成|執行|進行)[^。！？\n]{0,120}(?:審查|稽核|測試|遷移|部署)|(?:審查|稽核|測試|遷移|部署)[^。！？\n]{0,120}(?:已完成|已執行|已進行)/i;
const projectPattern = /\b(?:added|installed|download(?:ed| failures?)?|verified|not added|replaced|blocked|completed|deployed|deferred|updated?|implemented|fixed|rewrit(?:e|es|ing|ten)|task (?:was )?initiated|initiated a task|(?:the\s+)?task\s+(?:now\s+)?requires?|fresh\s+closure\s+review|needs? revision|not yet implemented|scope boundary|stage (?:is |was )?(?:strictly )?defined)\b|已加入|未加入|下載失敗|已驗證|完成|阻塞|延後|範圍邊界|已修正|尚未實作|未結案|更新|實施|修補|改寫|重寫|執行[^。！？\n]{0,40}任務/i;
const eventPattern = /\b(?:demonstrated|performed|executed|ran|showed)\b|展示|執行|進行/i;
const generalNegativePattern = /\b(?:does not prefer|doesn't prefer|dislikes?|hates?|avoids?|rejects?|must not|should not|not)\b|不喜歡|不偏好|不要|反對|不得|不應/i;
const generalPositivePattern = /\b(?:prefers?|must|should)\b|\b(?:i|we|you|they|he|she|user|arthur|nancy)\s+(?:really\s+)?(?:likes?|requires?|wants?)\b|偏好|喜歡|要求|希望|必須|應該/i;

const aliases: ReadonlyArray<readonly [RegExp, string]> = [
  [/深色模式|暗色模式|dark\s+mode/giu, " dark_mode "],
  [/所有(?:裝置|設備)|全部(?:裝置|設備)|all\s+devices?|every\s+device/giu, " all_devices "],
  [/(?:行動|移動)(?:裝置|設備)|手機|mobile\s+devices?|phones?/giu, " mobile_device "],
  [/桌上型電腦|桌機|電腦|desktop(?:\s+computers?)?/giu, " desktop_device "],
  [/夜間|晚上|night(?:time)?|evenings?/giu, " night_time "],
  [/安全(?:警示|通知)|security\s+(?:alerts?|notifications?)/giu, " security_alert "],
  [/繁體中文|正體中文|traditional\s+chinese/giu, " traditional_chinese "],
  [/互動|溝通|interactions?|communications?/giu, " interaction "],
  [/書面|written/giu, " written_interaction "],
  [/口語|語音|spoken|voice/giu, " voice_interaction "],
  [/第三人稱|third[- ]person/giu, " third_person "],
  [/短(?:篇)?遊戲|short(?:er)?\s+games?/giu, " short_game "],
  [/先行|優先|先玩|first|before/giu, " first "],
  [/生成(?:模型)?路由|generation\s*(?:route|routing|路由)/giu, " generation_routing "],
  [/通知|notifications?/giu, " notifications "],
  [/即時反應|real[- ]time\s+reactions?/giu, " realtime_reaction "],
  [/實況|直播|live\s+stream(?:ing)?/giu, " live_stream "],
  [/穿插|交錯|inline|interleav\w*|threaded|interspers\w*/giu, " inline_interleave "],
  [/故事|小說|情節|敘事|寫作|story|stories|narrative|narration|writing|novel/giu, " narrative "],
  [/分段|separate[ds]?|end[- ]of[- ](?:episode|section)/giu, " separated "],
  [/用戶|使用者|user/giu, " "],
  [/\b(?:does\s+not|doesn't|do\s+not|don't)\s+(?:prefer|like|want|require)\b/giu, " "],
  [/不喜歡|不偏好|比較喜歡|更喜歡|偏好|喜歡|不要|要求|希望/giu, " "],
  [/\b(?:i|we|you|they|he|she|arthur|nancy)\s+(?:really\s+)?likes?\b/giu, " "],
  [/prefers?|preference|dislikes?|requires?|wants?/giu, " "],
  [/模型|\bmodels?\b|\busing\b|\bplaying\b|玩/giu, " "],
  [/(?:設定為|使用|採用|進行|撰寫|書寫|回覆|回答|在|於|以|用)/giu, " "],
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
  const tokens = new Set(
    canonicalizedText(value)
      .split(" ")
      .filter((token) => token.length > 1 && !stopTokens.has(token)),
  );
  if (tokens.has("all") && (tokens.has("device") || tokens.has("devices"))) {
    tokens.delete("devices");
    tokens.add("device");
    tokens.add("mobile");
    tokens.add("desktop");
  }
  return tokens;
}

function inferredMemoryType(unit: ProviderMemoryUnit): MemoryType {
  const text = unit.proposedContent.text;
  if (hasExplicitPreferenceAssertion(text) || isNancyInlinePreferenceFamily(text)) {
    return "preference";
  }
  if (transientPattern.test(text)) return "transient_state";
  if (completedEventPattern.test(text)) return "event";
  if (projectPattern.test(text)) return "project_state";
  if (technicalPattern.test(text)) return "technical_fact";

  switch (unit.candidateType) {
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

  if (eventPattern.test(text)) return "event";
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

function polarityFor(text: string, concept: ReviewedSemanticConcept | undefined): SemanticPolarity {
  if (concept !== undefined) return polarityForReviewedConcept(text, concept);
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
): {
  semanticKey: string;
  concept?: ReviewedSemanticConcept;
  matchedConceptIds: string[];
} {
  const resolution = resolveReviewedSemanticConcept(
    unit.proposedContent.text,
    memoryType,
    speakerProvenance,
  );
  if (resolution.concept !== undefined) {
    return {
      semanticKey: resolution.concept.key,
      concept: resolution.concept,
      matchedConceptIds: resolution.matchedConceptIds,
    };
  }
  return {
    semanticKey: `semantic:${sha256({
      memoryType,
      memoryKind: unit.memoryKind,
      text: normalizeText(unit.proposedContent.text),
    }).slice("sha256:".length)}`,
    matchedConceptIds: resolution.matchedConceptIds,
  };
}

function isSubset(left: Set<string>, right: Set<string>): boolean {
  return [...left].every((token) => right.has(token));
}

export class DeterministicSemanticMemoryGovernance implements SemanticMemoryGovernance {
  constructor(readonly policyVersion = "dlmf-semantic-v6") {}

  classify(unit: ProviderMemoryUnit): SemanticClassification {
    const memoryType = inferredMemoryType(unit);
    const speakerProvenance = inferredSpeaker(unit);
    const epistemicStatus = attributedStatus(unit, memoryType, speakerProvenance);
    const { semanticKey, concept, matchedConceptIds } = semanticKeyFor(
      unit,
      memoryType,
      speakerProvenance,
    );
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
        ...(matchedConceptIds.length > 1
          ? [`semantic:concept_ambiguous:${matchedConceptIds.join(",")}`]
          : []),
      ],
    };
  }

  relate(unit: ProviderMemoryUnit, current: MemoryRevision): SemanticRelation {
    if (unit.semanticKey !== current.semanticKey) {
      throw new ValidationError("semantic relation requires an identical DLMF semantic key");
    }
    const candidateType = unit.memoryType ?? inferredMemoryType(unit);
    const candidateSpeaker = unit.speakerProvenance ?? inferredSpeaker(unit);
    const candidateResolution = resolveReviewedSemanticConcept(
      unit.proposedContent.text,
      candidateType,
      candidateSpeaker,
    );
    const currentResolution = resolveReviewedSemanticConcept(
      current.canonicalContent.text,
      current.memoryType,
      current.speakerProvenance,
    );
    const candidateConcept = candidateResolution.concept;
    const currentConcept = currentResolution.concept;
    if (
      candidateConcept === undefined &&
      currentConcept === undefined &&
      normalizeText(unit.proposedContent.text) === normalizeText(current.canonicalContent.text)
    ) {
      return "equivalent";
    }
    if (
      candidateConcept === undefined ||
      currentConcept === undefined ||
      candidateConcept.id !== currentConcept.id
    ) {
      return "unrelated";
    }
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
    if (isSubset(candidate, existing) && isSubset(existing, candidate)) {
      return "equivalent";
    }
    return candidateConcept.allowIncomparableEquivalent ? "equivalent" : "unrelated";
  }
}
