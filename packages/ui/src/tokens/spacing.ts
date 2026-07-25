/**
 * 间距 Token 源
 *
 * 当前阶段留空，使用 Tailwind 默认 spacing scale（0 / 0.5 / 1 / 2 / ... / 16 等）。
 * 后续如需统一自定义间距，在此添加。
 */

export const spacing = {} as const

export type SpacingToken = keyof typeof spacing
