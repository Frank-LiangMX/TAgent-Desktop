/**
 * 正文字号 atoms + applyFontSizeToDOM
 *
 * 5 档可调，作用于消息区 markdown 正文（--md-preview-font-size）。
 * 机制对齐 theme.ts：localStorage 持久化 + 写 documentElement CSS 变量。
 * globals.css 的 --md-preview-font-size: 14px 是兜底默认；这里覆盖之。
 */
import { atom, getDefaultStore } from 'jotai'

/** 字号档位：紧凑 / 小 / 标准 / 大 / 特大 */
export type FontSizeLevel = 0 | 1 | 2 | 3 | 4

/** 新安装与本次设置迁移统一使用标准正文档位。 */
export const STANDARD_FONT_SIZE_LEVEL: FontSizeLevel = 2

/** 正文标准行高：阅读型内容保持稳定节奏。 */
export const STANDARD_BODY_LINE_HEIGHT = 1.7

/** 5 档对应的 px 值（消息区正文） */
export const FONT_SIZE_PX: Record<FontSizeLevel, number> = {
  0: 12,
  1: 13,
  2: 14,
  3: 15,
  4: 16,
}

/** 档位中文标签 */
export const FONT_SIZE_LABELS: Record<FontSizeLevel, string> = {
  0: '紧凑',
  1: '小',
  2: '标准',
  3: '大',
  4: '特大',
}

const FONT_SIZE_CACHE_KEY = 'tagent-font-size-level'
const FONT_SIZE_STANDARDIZATION_KEY = 'tagent-font-size-standardized-v1'

function clampLevel(v: unknown): FontSizeLevel {
  const n = typeof v === 'number' ? v : Number(v)
  if (Number.isInteger(n) && n >= 0 && n <= 4) return n as FontSizeLevel
  return STANDARD_FONT_SIZE_LEVEL
}

function getCachedLevel(): FontSizeLevel {
  try {
    // 早期版本曾把当前设备的字号落在最小档；仅迁移一次到标准档，
    // 后续用户的任意手动选择都会继续按原键持久化。
    if (localStorage.getItem(FONT_SIZE_STANDARDIZATION_KEY) !== '1') {
      localStorage.setItem(FONT_SIZE_STANDARDIZATION_KEY, '1')
      localStorage.setItem(FONT_SIZE_CACHE_KEY, String(STANDARD_FONT_SIZE_LEVEL))
      return STANDARD_FONT_SIZE_LEVEL
    }
    return clampLevel(localStorage.getItem(FONT_SIZE_CACHE_KEY))
  } catch {
    return STANDARD_FONT_SIZE_LEVEL
  }
}

function cacheLevel(level: FontSizeLevel): void {
  try {
    localStorage.setItem(FONT_SIZE_CACHE_KEY, String(level))
  } catch {
    /* ignore */
  }
}

export const fontSizeLevelAtom = atom<FontSizeLevel>(getCachedLevel())

/** 把字号档位应用到 documentElement 的 --md-preview-font-size */
export function applyFontSizeToDOM(level: FontSizeLevel): void {
  const px = FONT_SIZE_PX[level] ?? FONT_SIZE_PX[STANDARD_FONT_SIZE_LEVEL]
  document.documentElement.style.setProperty('--md-preview-font-size', `${px}px`)
  document.documentElement.style.setProperty('--md-preview-line-height', String(STANDARD_BODY_LINE_HEIGHT))
}

/** 切字号档位（写 atom + localStorage + 立即应用 DOM） */
export function setFontSizeLevel(level: FontSizeLevel): void {
  const next = clampLevel(level)
  cacheLevel(next)
  getDefaultStore().set(fontSizeLevelAtom, next)
  applyFontSizeToDOM(next)
}
