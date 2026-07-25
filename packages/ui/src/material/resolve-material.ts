/**
 * 材质模式解析与校验
 *
 * @see MaterialMode
 */

import type { MaterialMode } from './material-types.ts'

/** 默认材质 = frosted（扁平 Material Design + 轻磨砂） */
export const DEFAULT_MATERIAL_MODE: MaterialMode = 'frosted'

/** 所有合法材质值，用于运行时校验 */
const MATERIAL_MODES: ReadonlySet<string> = new Set<MaterialMode>(['frosted', 'glass', 'soft'])

/**
 * 类型守卫：判断值是否为合法的 MaterialMode
 */
export function isMaterialMode(value: unknown): value is MaterialMode {
  return typeof value === 'string' && MATERIAL_MODES.has(value)
}

/**
 * 安全解析材质模式
 *
 * - 合法值直接返回
 * - 非法值或 undefined 返回 fallback（默认 = DEFAULT_MATERIAL_MODE）
 */
export function resolveMaterialMode(
  value: unknown,
  fallback: MaterialMode = DEFAULT_MATERIAL_MODE
): MaterialMode {
  return isMaterialMode(value) ? value : fallback
}
