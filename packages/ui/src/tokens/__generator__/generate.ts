/**
 * Token 生成器
 *
 * 读 token 源（radius/shadows/spacing/fontSize/motion/colors）→ 产出两个文件：
 *   - __generated__/tokens.css：CSS 变量，供 globals.css @import
 *   - __generated__/tailwind-theme.js：ESM Tailwind 配置对象，供 tailwind.config.js import
 *
 * 用法：bun run --filter @tagent/ui tokens:generate
 *
 * 幂等：同样输入产出同样输出，可重复运行。
 * 空对象 token 会被跳过，不产出变量。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { radius, shadows, spacing, fontSize, motion, colors, tailwindColorTokens } from '../index'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const generatedDir = resolve(__dirname, '..', '__generated__')

// ===== 生成 tokens.css =====

function generateCssVariableName(category: string, token: string): string {
  // 'glass-input' → '--radius-glass-input'
  return `--${category}-${token}`
}

function generateTailwindKey(token: string): string {
  // 'glass-input' → 'glass-input'（Tailwind key 直接用 token 名）
  return token
}

function buildCssBlock(category: string, tokens: Record<string, string>): string {
  const entries = Object.entries(tokens)
  if (entries.length === 0) return ''
  const lines = entries.map(
    ([key, value]) => `  ${generateCssVariableName(category, key)}: ${value};`
  )
  return `:root {\n${lines.join('\n')}\n}\n`
}

function buildTailwindObject(category: string, tokens: Record<string, string>): string {
  const entries = Object.entries(tokens)
  if (entries.length === 0) return '{}'
  const lines = entries.map(
    ([key]) => `  '${generateTailwindKey(key)}': 'var(${generateCssVariableName(category, key)})',`
  )
  return `{\n${lines.join('\n')}\n}`
}

/**
 * 将 ThemeName 映射到 CSS 选择器
 * 'default-light' → ':root'
 * 'default-dark' → '.dark'
 * 'ocean-light' → '.theme-ocean-light'
 */
function themeNameToSelector(name: string): string {
  if (name === 'default-light') return ':root'
  if (name === 'default-dark') return '.dark'
  return `.theme-${name}`
}

function generateTokensCss(): string {
  const blocks: string[] = []

  blocks.push(buildCssBlock('radius', radius))
  blocks.push(buildCssBlock('shadow', shadows))
  blocks.push(buildCssBlock('space', spacing))
  blocks.push(buildCssBlock('font', fontSize))
  blocks.push(buildCssBlock('motion', motion))

  // 颜色 token：为每个主题产出 CSS 变量块
  const themeEntries = Object.entries(colors)
  if (themeEntries.length > 0) {
    for (const [themeName, themeColors] of themeEntries) {
      const selector = themeNameToSelector(themeName)
      const lines = Object.entries(themeColors).map(([key, value]) => `  --${key}: ${value};`)
      blocks.push(`${selector} {\n${lines.join('\n')}\n}`)
    }
  }

  const nonEmpty = blocks.filter(Boolean).join('\n')

  return `/* ============================================
 * 此文件由 packages/ui/src/tokens/__generator__/generate.ts 自动生成
 * 请勿手动编辑，修改 token 请编辑 packages/ui/src/tokens/*.ts
 * 然后运行: bun run --filter @tagent/ui tokens:generate
 * ============================================ */

${nonEmpty}
`
}

// ===== 生成 tailwind-theme.js =====

function generateTailwindThemeJs(): string {
  const radiusObj = buildTailwindObject('radius', radius as Record<string, string>)
  const shadowObj = buildTailwindObject('shadow', shadows as Record<string, string>)
  const spacingObj = buildTailwindObject('space', spacing as Record<string, string>)
  const fontSizeObj = buildTailwindObject('font', fontSize as Record<string, string>)
  const motionObj = buildTailwindObject('motion', motion as Record<string, string>)

  // colors：用 tailwindColorTokens（指向现有 CSS 变量）
  const colorsJson = JSON.stringify(tailwindColorTokens, null, 2)

  return `/* ============================================
 * 此文件由 packages/ui/src/tokens/__generator__/generate.ts 自动生成
 * 请勿手动编辑，修改 token 请编辑 packages/ui/src/tokens/*.ts
 * 然后运行: bun run --filter @tagent/ui tokens:generate
 * ============================================ */

export const borderRadius = ${radiusObj}

export const boxShadow = ${shadowObj}

export const spacing = ${spacingObj}

export const fontSize = ${fontSizeObj}

export const motion = ${motionObj}

export const colors = ${colorsJson}
`
}

// ===== 主流程 =====

function main(): void {
  mkdirSync(generatedDir, { recursive: true })

  const cssContent = generateTokensCss()
  const cssPath = resolve(generatedDir, 'tokens.css')
  writeFileSync(cssPath, cssContent, 'utf-8')

  const themeJsContent = generateTailwindThemeJs()
  const themeJsPath = resolve(generatedDir, 'tailwind-theme.js')
  writeFileSync(themeJsPath, themeJsContent, 'utf-8')

  console.log(`[tokens:generate] 已生成:`)
  console.log(`  - ${cssPath}`)
  console.log(`  - ${themeJsPath}`)
  console.log(`  - radius tokens: ${Object.keys(radius).length} 个`)
  console.log(`  - shadow tokens: ${Object.keys(shadows).length} 个`)
  console.log(`  - spacing tokens: ${Object.keys(spacing).length} 个`)
  console.log(`  - fontSize tokens: ${Object.keys(fontSize).length} 个`)
  console.log(`  - motion tokens: ${Object.keys(motion).length} 个`)
  console.log(`  - color themes: ${Object.keys(colors).length} 个`)
}

main()
