/**
 * @tagent/ui - 共享 UI 组件和 Hooks
 */

// 基础组件（从 apps/electron/components/ui 迁移）
export * from './components/addon-loader'
export * from './components/alert'
export * from './components/alert-dialog'
export * from './components/badge'
export * from './components/button'
export * from './components/collapsible'
export * from './components/command'
export * from './components/context-menu'
export * from './components/dialog'
export * from './components/dropdown-menu'
export * from './components/image-lightbox'
export * from './components/input'
export * from './components/label'
export * from './components/loading-indicator'
export * from './components/play-pause-toggle'
export * from './components/popover'
export * from './components/scroll-area'
export * from './components/scroll-progress-container'
export * from './components/search-input'
export * from './components/segmented-tabs'
export * from './components/select'
export * from './components/separator'
export * from './components/sheet'
export * from './components/slider'
export * from './components/sonner'
export * from './components/spinner'
export * from './components/switch'
export * from './components/tabs'
export * from './components/textarea'
export * from './components/three-petal-spiral'
export * from './components/tooltip'
export * from './components/settings'
export * from './components/context-divider'
export * from './components/conversation'
export * from './components/reasoning'
export * from './components/message'
export * from './components/message-avatar'
export * from './components/input-toolbar-overflow'
export * from './components/speech-button'
export * from './components/sticky-user-message'
export * from './components/scroll-minimap'
export * from './components/file-path-chip'
export * from './components/copy-button'
export * from './components/attachment-preview-item'
export { UserAvatar } from './components/user-avatar'
export type { UserAvatarProps } from './components/user-avatar'

// 材质模式（MaterialMode / MaterialProvider / useMaterial / useMaterialMode）
export * from './material/index.ts'
export {
  surfaceRoles,
  surfaceRoleZIndex,
  isSurfaceRole,
  type SurfaceRole,
} from './tokens/surface-role'

// 富内容组件
export { CodeBlock } from './code-block/index.ts'
export { MermaidBlock } from './mermaid-block/index.ts'
export { useSmoothStream } from './hooks/index.ts'
