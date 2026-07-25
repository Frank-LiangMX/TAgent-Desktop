/**
 * TAgent Design Token 源
 *
 * 这里是所有 UI token 的权威源。
 * 修改后运行 `bun run --filter @tagent/ui tokens:generate`，
 * 生成器会自动产出：
 *   - tokens.css（CSS 变量，供 globals.css @import）
 *   - tailwind-theme.js（Tailwind 配置，供 tailwind.config.js import）
 *
 * 详见 packages/ui/DESIGN.md
 */

export { radius, type RadiusToken } from './radius'
export { shadows, type ShadowToken } from './shadows'
export { spacing, type SpacingToken } from './spacing'
export { fontSize, type FontSizeToken } from './fontSize'
export { motion, type MotionToken } from './motion'
export { surfaceRoles, surfaceRoleZIndex, isSurfaceRole, type SurfaceRole } from './surface-role'
export { colors, tailwindColorTokens, type ThemeName, type ThemeColors } from './colors'
