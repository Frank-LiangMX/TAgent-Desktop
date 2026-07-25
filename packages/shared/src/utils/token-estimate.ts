/**
 * 文本 Token 估算（字符级启发式）
 *
 * CJK ≈ 1.5 / ASCII ≈ 0.25 / 其他 ≈ 0.75，偏保守。
 * 主进程 Write 拦截与渲染进程提示词字数共用。
 */

/** 判断 Unicode 码点是否为 CJK 字符 */
export function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0x3000 && cp <= 0x303f) || // CJK Symbols and Punctuation
    (cp >= 0xff00 && cp <= 0xffef) || // Fullwidth Forms
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul Syllables
    (cp >= 0x3040 && cp <= 0x30ff) || // Hiragana + Katakana
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
    (cp >= 0x20000 && cp <= 0x2a6df) // CJK Extension B
  )
}

/** 估算文本的近似 token 数量 */
export function estimateTokenCount(text: string): number {
  let cjkCount = 0
  let asciiCount = 0
  let otherCount = 0

  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0
    if (isCjkCodePoint(cp)) {
      cjkCount++
    } else if (cp < 128) {
      asciiCount++
    } else {
      otherCount++
    }
  }

  return Math.ceil(cjkCount * 1.5 + asciiCount * 0.25 + otherCount * 0.75)
}
