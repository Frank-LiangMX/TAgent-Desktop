import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 已归档侧栏「单行结构」守卫。
 *
 * 这些不是像素快照，而是结构性不变量，用来防止归档行退回到「标题一行 + 右侧已归档
 * 掉到第二行」的旧布局，并保证已归档状态仍以文字/语义（而非纯颜色）表达。
 *
 * 选源文件而非渲染 DOM：本仓库 renderer 侧现有测试均为纯逻辑模型测试，未引入
 * @testing-library/react 等渲染依赖；这里也不新增依赖，直接守卫产出单行结构的
 * JSX/CSS 不变量。
 */
const here = dirname(fileURLToPath(import.meta.url))
const sidebarCss = readFileSync(resolve(here, '../../styles/sidebar.css'), 'utf8')
const sidebarTsx = readFileSync(resolve(here, './SessionSidebar.tsx'), 'utf8')

/** 取 CSS 中某选择器第一个规则块的内文（{ 与 } 之间，不含嵌套）。 */
function cssBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = css.match(new RegExp(escaped + '\\s*\\{([^}]*)\\}', 'm'))
  return m ? (m[1] ?? '') : ''
}

describe('已归档侧栏单行结构', () => {
  it('归档行隐藏原 meta 第二行（结构性保证不落第二行）', () => {
    const meta = cssBlock(sidebarCss, '.row-archived .meta')
    expect(meta).toBeTruthy()
    expect(meta).toMatch(/display:\s*none/)
  })

  it('归档行内联「已归档」状态规则存在（贴右、不换行、同基线）', () => {
    const status = cssBlock(sidebarCss, '.row-archived .arch-status')
    expect(status).toBeTruthy()
    expect(status).toMatch(/margin-left:\s*auto/)
    expect(status).toMatch(/white-space:\s*nowrap/)
  })

  it('归档行为单行紧凑高度，不再是双行 40/50px', () => {
    const row = cssBlock(sidebarCss, '.row-archived')
    expect(row).toBeTruthy()
    const m = row.match(/min-height:\s*([0-9.]+)px/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBeLessThanOrEqual(34)
  })

  it('归档行圆角收敛，不再是大圆角卡片', () => {
    const row = cssBlock(sidebarCss, '.row-archived')
    expect(row).toMatch(/border-radius:\s*8px/)
  })

  it('归档行 hover 沿用 .row 通用态，无独立视觉系统', () => {
    expect(sidebarCss).not.toMatch(/\.row-archived:hover/)
  })

  it('归档抽屉外圆角收敛（16 → 12），弱化双层卡片', () => {
    const foot = cssBlock(sidebarCss, '.arch-foot')
    expect(foot).toMatch(/border-radius:\s*12px\s+12px\s+0\s+0/)
  })

  it('SessionRow 归档行内联「已归档」状态，不依赖颜色', () => {
    expect(sidebarTsx).toContain('className="arch-status"')
    expect(sidebarTsx).toContain('已归档')
  })

  it('SessionRow 仅非归档行渲染 meta 第二行', () => {
    expect(sidebarTsx).toContain('{!archived && (')
    // 旧的「archived ? 已归档 : 时间」第二行写法已移除
    expect(sidebarTsx).not.toMatch(/archived \? '已归档'/)
  })

  it('归档分组头仍含「已归档」标题 + 数量徽标 + aria-expanded', () => {
    expect(sidebarTsx).toContain('gname muted')
    expect(sidebarTsx).toContain('aria-expanded={archivedOpen}')
    expect(sidebarTsx).toContain('{visibleArchivedSessions.length}')
  })
})
