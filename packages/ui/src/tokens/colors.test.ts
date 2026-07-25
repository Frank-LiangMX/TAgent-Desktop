import { describe, expect, test } from 'vitest'

import { colors, type ThemeColors, type ThemeName } from './colors'

/**
 * Scene 弥散环境色 + 默认浅色 WCAG AA 对比度测试。
 *
 * 约束（见 docs/plans/2026-07-18-spatial-ui-theme-material-architecture.md §7）：
 * - 主题轴负责色相与 scene 环境光；材质轴负责 frosted/glass/soft 光学。
 * - 每个主题必须自带 scene-base / scene-ambient-a / scene-ambient-b，不再共用写死蓝灰。
 * - 默认浅色：正文、次要文字、主按钮白字 ≥ WCAG AA（4.5:1）。
 */

const THEME_NAMES = Object.keys(colors) as ThemeName[]

const SCENE_KEYS = ['scene-base', 'scene-ambient-a', 'scene-ambient-b', 'scene-ambient-c'] as const

const SCENE_RGB_KEYS = [
  'scene-base-rgb',
  'scene-a-rgb',
  'scene-b-rgb',
  'scene-c-rgb',
  'glass-rgb',
] as const

// ===== HSL → 线性 RGB → 相对亮度 → 对比度（WCAG 2.x）=====

/** 解析 "214 24% 96%" → { h: 214, s: 0.24, l: 0.96 } */
function parseHsl(token: string): { h: number; s: number; l: number } {
  const parts = token.trim().split(/\s+/)
  const h = Number(parts[0] ?? 0) % 360
  const s = Number((parts[1] ?? '0').replace('%', '')) / 100
  const l = Number((parts[2] ?? '0').replace('%', '')) / 100
  return { h, s, l }
}

/** HSL（0-1）→ sRGB（0-1） */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = h / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (hp >= 0 && hp < 1) [r, g, b] = [c, x, 0]
  else if (hp < 2) [r, g, b] = [x, c, 0]
  else if (hp < 3) [r, g, b] = [0, c, x]
  else if (hp < 4) [r, g, b] = [0, x, c]
  else if (hp < 5) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return [r + m, g + m, b + m]
}

/** sRGB（0-1）→ 线性通道 */
function linearize(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)
}

/** token → 相对亮度（Y） */
function luminance(token: string): number {
  const { h, s, l } = parseHsl(token)
  const [r, g, b] = hslToRgb(h, s, l)
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b)
}

/** 两色对比度（1-21） */
function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  const light = Math.max(la, lb)
  const dark = Math.min(la, lb)
  return (light + 0.05) / (dark + 0.05)
}

describe('scene 弥散环境色', () => {
  test('每个主题都完整定义 scene 三元组', () => {
    for (const name of THEME_NAMES) {
      const theme: ThemeColors = colors[name]
      for (const key of SCENE_KEYS) {
        const value = theme[key]
        expect(value, `${name} 缺少 ${key}`).toBeTruthy()
        // 三元组格式 "H S% L%"（运行时已由上面 toBeTruthy 保证非空，`?? ''` 仅为满足 TS strict）
        expect(value ?? '', `${name}.${key} 非法 HSL 三元组`).toMatch(
          /^\d+(\.\d+)?\s+\d+(\.\d+)?%\s+\d+(\.\d+)?%$/
        )
      }
    }
  })

  test('每个主题都定义完整的三光源 RGB、位置、尺寸与强度', () => {
    for (const name of THEME_NAMES) {
      const theme = colors[name]
      for (const key of SCENE_RGB_KEYS) {
        expect(theme[key], `${name}.${key}`).toMatch(/^\d{1,3}\s+\d{1,3}\s+\d{1,3}$/)
      }
      for (const light of ['a', 'b', 'c'] as const) {
        expect(theme[`scene-${light}-pos`], `${name}.${light}.pos`).toMatch(/^\d+%\s+\d+%$/)
        expect(theme[`scene-${light}-size`], `${name}.${light}.size`).toMatch(/^\d+%\s+\d+%$/)
        const strength = Number(theme[`scene-${light}-strength`])
        expect(strength, `${name}.${light}.strength`).toBeGreaterThan(0)
        expect(strength, `${name}.${light}.strength`).toBeLessThanOrEqual(0.5)
      }
    }
  })

  test('浅色主题 scene-base 为高亮度冷灰底（≥ 86%，对齐 layout-direction-study）', () => {
    const lightThemes = THEME_NAMES.filter((n) => n.endsWith('-light'))
    for (const name of lightThemes) {
      const { l } = parseHsl(colors[name]['scene-base'])
      // 原型 #d9dee7 ≈ L88%；禁止再压成近纯白瓷板（≥96%）
      expect(l, `${name} scene-base 应 ≥ 86% 亮度`).toBeGreaterThanOrEqual(0.86)
      expect(l, `${name} scene-base 应 < 96%（保留弥散可见）`).toBeLessThan(0.96)
    }
  })

  test('深色主题 scene-base 为低亮度深底（≤ 18%）', () => {
    const darkThemes = THEME_NAMES.filter((n) => n.endsWith('-dark'))
    for (const name of darkThemes) {
      const { l } = parseHsl(colors[name]['scene-base'])
      expect(l, `${name} scene-base 应 ≤ 18% 亮度`).toBeLessThanOrEqual(0.18)
    }
  })

  test('scene-ambient-a 比 scene-base 更饱和（光斑可见）', () => {
    for (const name of THEME_NAMES) {
      const baseS = parseHsl(colors[name]['scene-base']).s
      const aS = parseHsl(colors[name]['scene-ambient-a']).s
      expect(aS, `${name} scene-ambient-a 饱和度应高于 base`).toBeGreaterThan(baseS)
    }
  })

  test('默认浅色 scene-ambient-b 是受控灰玫瑰雾（饱和 ≤ 35%，强度 ≤ 0.3）', () => {
    const { s, h } = parseHsl(colors['default-light']['scene-ambient-b'])
    expect(s).toBeLessThanOrEqual(0.35)
    expect(Number(colors['default-light']['scene-b-strength'])).toBeLessThanOrEqual(0.3)
    // 与冷蓝真正撞色：玫瑰/珊瑚轴，禁止近蓝的紫
    expect(h).toBeGreaterThanOrEqual(0)
    expect(h).toBeLessThanOrEqual(25)
  })

  test('默认浅色 scene-base 为冷灰蓝（hue ∈ [210, 230]）', () => {
    const { h } = parseHsl(colors['default-light']['scene-base'])
    expect(h).toBeGreaterThanOrEqual(210)
    expect(h).toBeLessThanOrEqual(230)
  })

  test('默认浅色 A/B/C 三色撞色（冷蓝 × 灰玫瑰 × 薄荷）', () => {
    const aH = parseHsl(colors['default-light']['scene-ambient-a']).h
    const bH = parseHsl(colors['default-light']['scene-ambient-b']).h
    const cH = parseHsl(colors['default-light']['scene-ambient-c']).h
    // A 冷蓝
    expect(aH).toBeGreaterThanOrEqual(200)
    expect(aH).toBeLessThanOrEqual(230)
    // B 灰玫瑰（远离蓝紫相近色）
    expect(bH).toBeGreaterThanOrEqual(0)
    expect(bH).toBeLessThanOrEqual(25)
    // C 薄荷/灰绿
    expect(cH).toBeGreaterThanOrEqual(130)
    expect(cH).toBeLessThanOrEqual(170)
  })
})

describe('默认浅色 WCAG AA 对比度（≥ 4.5:1）', () => {
  const theme = colors['default-light']
  const AA = 4.5

  test('正文（foreground on background）', () => {
    expect(contrast(theme.foreground, theme.background)).toBeGreaterThanOrEqual(AA)
  })

  test('次要文字（muted-foreground on background）', () => {
    expect(contrast(theme['muted-foreground'], theme.background)).toBeGreaterThanOrEqual(AA)
  })

  test('主按钮白字（primary-foreground on primary）', () => {
    expect(contrast(theme['primary-foreground'], theme.primary)).toBeGreaterThanOrEqual(AA)
  })

  test('卡片正文（card-foreground on card）', () => {
    expect(contrast(theme['card-foreground'], theme.card)).toBeGreaterThanOrEqual(AA)
  })

  test('默认浅色 primary 为矿物蓝而非 AI 紫（hue ∈ [200, 230]）', () => {
    const { h } = parseHsl(theme.primary)
    // 200-230 = 冷蓝/矿物蓝区间；AI 紫通常 hue ~265-290
    expect(h).toBeGreaterThanOrEqual(200)
    expect(h).toBeLessThanOrEqual(230)
  })
})
