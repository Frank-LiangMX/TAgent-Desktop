/**
 * 材质模式类型定义
 *
 * MaterialMode 是 TAgent 三个材质轴之一（appearance × palette × material）。
 * 三种材质只改变光学表现（blur / 透明度 / 阴影 / 高光），不改变业务颜色或功能结构。
 *
 * @see docs/decisions/0005-material-surface-token-architecture.md
 * @see docs/plans/2026-07-18-spatial-ui-theme-material-architecture.md §7
 */

/** 三种材质模式 */
export type MaterialMode = 'frosted' | 'glass' | 'soft'

/** MaterialProvider 的 React context 值 */
export interface MaterialContextValue {
  /** 当前生效的材质模式 */
  readonly mode: MaterialMode
}
