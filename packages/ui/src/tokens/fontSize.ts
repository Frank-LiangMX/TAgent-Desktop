/**
 * 字号 Token 源
 *
 * 当前阶段留空，使用 Tailwind 默认 fontSize scale（xs / sm / base / lg / xl 等）。
 * 后续如需统一自定义字号，在此添加。
 */

export const fontSize = {} as const

export type FontSizeToken = keyof typeof fontSize
