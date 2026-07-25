/**
 * TAgent 表面语义层级。
 *
 * Role 只描述空间职责，不绑定具体材质。实际光学值由
 * packages/ui/styles/surface-roles.css 映射到当前 Material Token。
 */
export const surfaceRoles = [
  'scene',
  'workspace',
  'navigation',
  'panel',
  'panel-elevated',
  'well',
  'control',
  'interactive-elevated',
  'overlay',
  'modal',
] as const

export type SurfaceRole = (typeof surfaceRoles)[number]

/** 各语义层的默认层叠高度；组件内部仍应建立自己的 stacking context。 */
export const surfaceRoleZIndex = {
  scene: 0,
  workspace: 10,
  navigation: 10,
  panel: 10,
  'panel-elevated': 10,
  well: 0,
  control: 0,
  'interactive-elevated': 20,
  overlay: 100,
  modal: 1000,
} as const satisfies Record<SurfaceRole, number>

export function isSurfaceRole(value: unknown): value is SurfaceRole {
  return typeof value === 'string' && (surfaceRoles as readonly string[]).includes(value)
}
