/**
 * @tagent/ui 材质模块公共 API
 */

export type { MaterialMode, MaterialContextValue } from './material-types.ts'
export { DEFAULT_MATERIAL_MODE, isMaterialMode, resolveMaterialMode } from './resolve-material.ts'
export { MaterialProvider, useMaterial, useMaterialMode } from './MaterialProvider.tsx'
export type { MaterialProviderProps } from './MaterialProvider.tsx'
