const englishActorPreferencePattern =
  /\b(?:i|we|you|they|he|she|user|arthur|nancy)\s+(?:(?:explicitly|clearly|really)\s+)?(?:prefers?|dislikes?|likes?|requires?|wants?)\b/i;
const englishActorNegativePreferencePattern =
  /\b(?:i|we|you|they|he|she|user|arthur|nancy)\s+(?:(?:explicitly|clearly|really)\s+)?(?:does\s+not|doesn't|do\s+not|don't)\s+(?:prefer|like|want|require)\b/i;
const englishActorPreferenceNounPattern =
  /\b(?:(?:my|our|your|their|his|her)\s+preference|(?:user|arthur|nancy)(?:'s)?\s+preference|(?:i|we|you|they|he|she|user|arthur|nancy)\s+would\s+rather)\b/i;
const chineseActorPreferencePattern =
  /(?:用戶|使用者|我|我們|Nancy)\s*(?:的)?\s*(?:明確|清楚|最新|現在)?\s*(?:偏好|比較喜歡|更喜歡|不喜歡|喜歡|要求|希望)/i;

const durableOperationalScopePattern =
  /(?:以後|今後|往後|未來|每次|每一步|每一(?:次|步)|一律|總是|預設|默認|自動|除非|沒有[^。！？\n]{0,40}阻塞|無[^。！？\n]{0,40}阻塞|不用[^。！？\n]{0,40}(?:詢問|問我)|不需要[^。！？\n]{0,40}(?:詢問|問我))|\b(?:from\s+now\s+on|going\s+forward|in\s+the\s+future|always|every\s+(?:time|step)|by\s+default|automatically|autonomously|unless|whenever|without\s+asking|do\s+not\s+ask\s+me\s+every|don't\s+ask\s+me\s+every|if\s+(?:there\s+is\s+|there's\s+)?no\s+blocker|when\s+(?:there\s+is\s+|there's\s+)?no\s+blocker)\b/i;
const directChineseOperationalDirectivePattern =
  /^(?:請|麻煩)?\s*(?:直接)?\s*(?:開始(?:吧|執行(?:任務)?|任務)?|繼續(?:吧|執行|完成|進行|做|往下)?|下一步|往下|進行下一步|恢復(?:吧|執行)?|目前進度(?:如何|呢|怎樣|怎麼樣)?)\s*[吧嗎呢啊喔哦?？!！。]*$/i;
const directEnglishOperationalDirectivePattern =
  /^(?:please\s+)?(?:just\s+)?(?:start|begin|continue|proceed|go\s+ahead|keep\s+going|resume)(?:\s+(?:the\s+)?(?:task|work|execution|process))?\s*[?!.]*$|^(?:please\s+)?(?:the\s+)?next\s+step\s*[?!.]*$|^what(?:'s|\s+is)\s+(?:the\s+)?current\s+progress\s*[?!.]*$/i;
const summarizedChineseOperationalDirectivePattern =
  /(?:用戶|使用者)\s*(?:要求|希望|指示|請求)\s*(?:(?:Agent|代理|助理)\s*)?(?:開始|繼續|往下|進行下一步|恢復)(?:\s*(?:執行|完成|進行))?(?:\s*(?:任務|工作|流程))?/i;
const summarizedEnglishOperationalDirectivePattern =
  /\b(?:the\s+)?user\s+(?:asked|requested|told|instructed|wanted)\s+(?:(?:the\s+)?agent\s+)?(?:to\s+)?(?:start|begin|continue|proceed|resume|keep\s+going|go\s+ahead)(?:\s+(?:the\s+)?(?:task|work|execution|process))?\b|\b(?:the\s+)?user\s+(?:asked|requested)\s+(?:for\s+)?(?:the\s+)?(?:task|work|execution|process)\s+to\s+(?:start|begin|continue|proceed|resume)\b/i;
const progressRequestPattern =
  /(?:用戶|使用者)\s*(?:詢問|要求|想知道)[^。！？\n]{0,32}(?:目前|當前)?\s*進度|\b(?:the\s+)?user\s+(?:asked|requested|wanted\s+to\s+know)[^.!?\n]{0,48}(?:current\s+)?progress\b/i;

const liveCommentaryPattern = /nancy|live|stream|commentary|實況|直播|操作|吐槽|反應/i;
const placementPattern = /inline|interleav|threaded|interspers|within|directly|separate|end[- ]of[- ](?:episode|section)|穿插|交錯|直接|分段|章末/i;
const narrativePattern = /story|stories|narrative|novel|episode|section|format|style|故事|小說|情節|段落|正文|格式|風格/i;
const englishInlineNormativePattern =
  /\b(?:live\s+content|commentary|nancy|novel|story|narrative|format|style)\b[^.!?\n]{0,180}\b(?:must|should|needs?\s+to|is\s+required\s+to)\b[^.!?\n]{0,220}\b(?:inline|interleav\w*|threaded|interspers\w*|directly|within)\b/i;
const chineseInlineNormativePattern =
  /(?:實況|直播|操作|吐槽|反應|小說|故事|情節|正文|格式|風格)[^。！？\n]{0,180}(?:必須|應該|需要|需直接|不得|不可)[^。！？\n]{0,220}(?:穿插|交錯|直接|正文)/i;

const operationalBehaviorPattern =
  /(?:繼續|開始|執行|往下|詢問|問我)|\b(?:continue|proceed|resume|execute|execution|ask|autonomous|autonomously)\b/i;

/** A cross-session execution rule rather than a command for the current turn. */
export function isDurableOperationalPreference(text: string): boolean {
  const normalized = text.normalize("NFKC").trim();
  return (
    normalized.length > 0 &&
    durableOperationalScopePattern.test(normalized) &&
    operationalBehaviorPattern.test(normalized)
  );
}

/**
 * One-shot control-plane instructions have value only while the current task or
 * session is being executed. Durable/recurrent execution preferences explicitly
 * override this detector so "continue unless blocked, without asking each step"
 * remains eligible for long-term preference governance.
 */
export function isOneShotOperationalDirective(text: string): boolean {
  const normalized = text.normalize("NFKC").trim();
  if (normalized.length === 0 || isDurableOperationalPreference(normalized)) return false;
  return (
    directChineseOperationalDirectivePattern.test(normalized) ||
    directEnglishOperationalDirectivePattern.test(normalized) ||
    summarizedChineseOperationalDirectivePattern.test(normalized) ||
    summarizedEnglishOperationalDirectivePattern.test(normalized) ||
    progressRequestPattern.test(normalized)
  );
}

/**
 * A durable preference needs an explicit preference expression tied to an actor.
 * Generic requirements and one-shot execution controls are deliberately excluded.
 */
export function hasExplicitPreferenceAssertion(text: string): boolean {
  if (isOneShotOperationalDirective(text)) return false;
  if (isDurableOperationalPreference(text)) return true;
  return (
    englishActorPreferencePattern.test(text) ||
    englishActorNegativePreferencePattern.test(text) ||
    englishActorPreferenceNounPattern.test(text) ||
    chineseActorPreferencePattern.test(text)
  );
}

/**
 * Bounded, reviewed multilingual concept family for Nancy commentary placement.
 * Mere co-occurrence of novel/live/placement terms is not enough: the text must
 * express a preference or a normative format rule.
 */
export function isNancyInlinePreferenceFamily(text: string): boolean {
  if (
    !liveCommentaryPattern.test(text) ||
    !placementPattern.test(text) ||
    !narrativePattern.test(text)
  ) {
    return false;
  }
  return (
    hasExplicitPreferenceAssertion(text) ||
    englishInlineNormativePattern.test(text) ||
    chineseInlineNormativePattern.test(text)
  );
}
