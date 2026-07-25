/**
 * MaterialProvider — 材质模式 React Context
 *
 * 负责将解析后的 MaterialMode 通过 React Context 传递给子组件。
 * 不执行 DOM mutation（`html[data-material]` 由 Electron 侧负责），
 * 不 import app atom（`packages/ui` 禁止反向依赖 Electron）。
 *
 * @see docs/plans/2026-07-18-spatial-ui-theme-material-architecture.md §9.2
 */

import { createContext, useContext, useMemo } from 'react'

import type { ReactNode } from 'react'

import type { MaterialContextValue, MaterialMode } from './material-types.ts'
import { DEFAULT_MATERIAL_MODE, resolveMaterialMode } from './resolve-material.ts'

const MaterialContext = createContext<MaterialContextValue>({ mode: DEFAULT_MATERIAL_MODE })
MaterialContext.displayName = 'MaterialContext'

export interface MaterialProviderProps {
  /** 已解析的材质模式；运行时异常值会安全回退到 DEFAULT_MATERIAL_MODE。 */
  readonly value: MaterialMode
  readonly children: ReactNode
}

/**
 * MaterialProvider 将材质模式注入 React 子树。
 *
 * ```tsx
 * <MaterialProvider value={resolvedMaterialMode}>
 *   <AppShell />
 * </MaterialProvider>
 * ```
 */
export function MaterialProvider({ value: materialMode, children }: MaterialProviderProps) {
  const resolved = resolveMaterialMode(materialMode)
  const value = useMemo<MaterialContextValue>(() => ({ mode: resolved }), [resolved])

  return <MaterialContext.Provider value={value}>{children}</MaterialContext.Provider>
}

/**
 * 获取当前材质模式的完整 context 值。
 * 在 MaterialProvider 外调用时返回默认值，确保独立渲染的组件安全降级。
 */
export function useMaterial(): MaterialContextValue {
  return useContext(MaterialContext)
}

/**
 * 仅获取当前材质模式字符串的便捷 hook。
 */
export function useMaterialMode(): MaterialMode {
  return useMaterial().mode
}
