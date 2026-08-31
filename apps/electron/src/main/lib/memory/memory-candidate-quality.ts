/**
 * 记忆候选质量门控：过滤 path-slug / 半截纠正 / 空洞洞察，避免污染 stage 与 L5。
 */

/**
 * workspace sanitizePath 产物（F:\TAgent-Desktop → F--TAgent-Desktop）。
 * 真实 Windows 路径用盘符:\，不会出现「盘符--」。
 */
const PATH_SLUG_TOKEN_RE = /[A-Za-z]--[\w.-]+/

/** Reflect 规则兜底曾写出的关键词偏好废话 */
const KEYWORD_PREFERENCE_FLUFF_RE =
  /用户在多个场景提到「[^」]{1,30}」，可能是一个重要偏好/


const INCOMPLETE_MEMORY_END_RE = /(?:[，、：:]|而|也|的|或|和|与|是|为|在|对|把|将|等)$/
/** L5 洞察最低置信度（consolidation 结构化写入） */
export const MIN_INSIGHT_CONFIDENCE = 0.75

/**
 * 判断候选正文是否低质量、不应入 stage / 不应落盘。
 */
export function isLowQualityMemoryContent(
  content: string,
  opts?: { type?: string; targetLayer?: string },
): boolean {
  const t = content.trim()
  if (!t || t === '...' || t.length < 4) return true
  // 裸 slug 或把 slug 写进「项目/路径」句子，都不是可读记忆
  if (PATH_SLUG_TOKEN_RE.test(t)) return true

  const isCorrection = opts?.type === 'correction' || opts?.targetLayer === 'L3'
  if (isCorrection) {
    if (t.length < 10) return true
    // 纠正正则常截出半截指令，例如「改成员，Slate」「改为队列模式。」
    if (/^改[成变为成员标签]/.test(t) && t.length <= 16) return true
    if (/^(改为队列模式|改变标签，跳过|改成员)/.test(t) && t.length < 24) return true

  }

  // 适用于所有层级：孤立的半句话不能直接成为长期记忆。
  if (INCOMPLETE_MEMORY_END_RE.test(t)) return true
  if (isCorrection && /(?:\.\.\.|…)$/.test(t)) return true

  return false
}

/**
 * L5 洞察质量门控：丢掉关键词偏好废话、过短条目、低置信度。
 */
export function isLowQualityInsight(
  content: string,
  opts?: { confidence?: number },
): boolean {
  const t = content.trim()
  if (!t || t.length < 12) return true
  if (PATH_SLUG_TOKEN_RE.test(t)) return true
  if (KEYWORD_PREFERENCE_FLUFF_RE.test(t)) return true
  if (/可能是一个重要偏好/.test(t)) return true
  if (
    opts?.confidence !== undefined &&
    Number.isFinite(opts.confidence) &&
    opts.confidence < MIN_INSIGHT_CONFIDENCE
  ) {
    return true
  }
  return false
}

/** stage / consolidation 内容去重键 */
export function memoryContentDedupeKey(targetLayer: string, content: string): string {
  return `${targetLayer}\0${content.trim()}`
}
