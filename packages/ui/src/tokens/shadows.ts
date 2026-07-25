/**
 * 阴影 Token 源
 *
 * 当前阶段留空结构，session-glass-* 类的 box-shadow 包含主题色引用
 * （如 hsl(var(--tooltip-foreground) / 0.10)），不适合抽成纯数值 token。
 * 后续如需统一阴影，在此添加。
 */

export const shadows = {} as const

export type ShadowToken = keyof typeof shadows
