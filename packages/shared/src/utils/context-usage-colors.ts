/**
 * Context Usage 分类色板 — 对齐 Cursor / Claude Code 语义色。
 * SDK 可能返回语义名（purple）、无 # 的 hex、或空字符串，需归一化为可用 CSS 色值。
 */

/** 语义色名 → 固定 hex（深浅主题下均可辨识） */
export const CONTEXT_USAGE_SWATCH = {
  gray: '#9CA3AF',
  grey: '#9CA3AF',
  purple: '#A78BFA',
  green: '#34D399',
  yellow: '#FBBF24',
  pink: '#F472B6',
  blue: '#60A5FA',
  orange: '#FB923C',
  red: '#F87171',
  cyan: '#22D3EE',
  teal: '#2DD4BF',
} as const satisfies Record<string, string>

const DEFAULT_CONTEXT_USAGE_COLOR = CONTEXT_USAGE_SWATCH.gray

/** 按分类名 fallback（SDK color 缺失或无法解析时） */
export const CONTEXT_USAGE_CATEGORY_COLORS: Record<string, string> = {
  'System prompt': CONTEXT_USAGE_SWATCH.gray,
  'System tools': CONTEXT_USAGE_SWATCH.purple,
  'Tool definitions': CONTEXT_USAGE_SWATCH.purple,
  Rules: CONTEXT_USAGE_SWATCH.green,
  Skills: CONTEXT_USAGE_SWATCH.yellow,
  'MCP tools': CONTEXT_USAGE_SWATCH.pink,
  MCP: CONTEXT_USAGE_SWATCH.pink,
  'Custom agents': CONTEXT_USAGE_SWATCH.blue,
  Agents: CONTEXT_USAGE_SWATCH.blue,
  Messages: CONTEXT_USAGE_SWATCH.orange,
  Conversation: CONTEXT_USAGE_SWATCH.orange,
  'Summarized conversation': CONTEXT_USAGE_SWATCH.red,
  Memory: CONTEXT_USAGE_SWATCH.green,
  Attachments: CONTEXT_USAGE_SWATCH.orange,
  'Slash commands': CONTEXT_USAGE_SWATCH.gray,
  'Free space': '#D1D5DB',
}

function normalizeHex(raw: string): string | undefined {
  const value = raw.trim()
  if (/^#[0-9a-fA-F]{3,8}$/.test(value)) return value
  if (/^[0-9a-fA-F]{6}$/.test(value)) return `#${value}`
  if (/^[0-9a-fA-F]{3}$/.test(value)) {
    return `#${value[0]}${value[0]}${value[1]}${value[1]}${value[2]}${value[2]}`
  }
  return undefined
}

/** 将 SDK / 缓存中的 color 字段解析为可用于 CSS 的色值 */
export function resolveContextUsageColor(categoryName: string, rawColor?: string): string {
  const normalized = rawColor?.trim()
  if (normalized) {
    const hex = normalizeHex(normalized)
    if (hex) return hex

    if (
      normalized.startsWith('rgb(') ||
      normalized.startsWith('rgba(') ||
      normalized.startsWith('hsl(') ||
      normalized.startsWith('hsla(')
    ) {
      return normalized
    }

    const swatchKey = normalized.toLowerCase()
    if (swatchKey in CONTEXT_USAGE_SWATCH) {
      return CONTEXT_USAGE_SWATCH[swatchKey as keyof typeof CONTEXT_USAGE_SWATCH]
    }
  }

  return CONTEXT_USAGE_CATEGORY_COLORS[categoryName] ?? DEFAULT_CONTEXT_USAGE_COLOR
}
