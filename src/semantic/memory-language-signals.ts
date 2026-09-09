const englishActorPreferencePattern =
  /\b(?:i|we|you|they|he|she|user|arthur|nancy)\s+(?:(?:explicitly|clearly|really)\s+)?(?:prefers?|dislikes?|likes?|requires?|wants?)\b/i;
const englishActorNegativePreferencePattern =
  /\b(?:i|we|you|they|he|she|user|arthur|nancy)\s+(?:(?:explicitly|clearly|really)\s+)?(?:does\s+not|doesn't|do\s+not|don't)\s+(?:prefer|like|want|require)\b/i;
const englishPreferenceNounPattern = /\b(?:preference|would rather)\b/i;
const chineseActorPreferencePattern =
  /(?:用戶|使用者|我|我們|Nancy)\s*(?:明確|清楚|最新|現在)?\s*(?:偏好|比較喜歡|更喜歡|不喜歡|喜歡|要求|希望)/i;
const chinesePreferenceWordPattern = /偏好|比較喜歡|更喜歡|不喜歡|喜歡/i;

const liveCommentaryPattern = /nancy|live|stream|commentary|實況|直播|操作|吐槽|反應/i;
const placementPattern = /inline|interleav|threaded|interspers|within|directly|separate|end[- ]of[- ](?:episode|section)|穿插|交錯|直接|分段|章末/i;
const narrativePattern = /story|stories|narrative|novel|episode|section|format|style|故事|小說|情節|段落|正文|格式|風格/i;
const englishInlineNormativePattern =
  /\b(?:live\s+content|commentary|nancy|novel|story|narrative|format|style)\b[^.!?\n]{0,180}\b(?:must|should|needs?\s+to|is\s+required\s+to)\b[^.!?\n]{0,220}\b(?:inline|interleav\w*|threaded|interspers\w*|directly|within)\b/i;
const chineseInlineNormativePattern =
  /(?:實況|直播|操作|吐槽|反應|小說|故事|情節|正文|格式|風格)[^。！？\n]{0,180}(?:必須|應該|需要|需直接|不得|不可)[^。！？\n]{0,220}(?:穿插|交錯|直接|正文)/i;

/**
 * A durable preference needs an explicit preference expression tied to an actor.
 * Generic requirements inside task descriptions are deliberately excluded.
 */
export function hasExplicitPreferenceAssertion(text: string): boolean {
  return (
    englishActorPreferencePattern.test(text) ||
    englishActorNegativePreferencePattern.test(text) ||
    englishPreferenceNounPattern.test(text) ||
    chineseActorPreferencePattern.test(text) ||
    chinesePreferenceWordPattern.test(text)
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
