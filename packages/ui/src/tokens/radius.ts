/**
 * 圆角 Token 源
 *
 * 所有 session-glass-* 类的 border-radius 必须引用这里的 token，
 * 改一处全局生效。
 *
 * 命名约定：`glass-{组件名}` 对应 .session-glass-{组件名} 类
 * 其他圆角用语义名（如 `control` = 按钮输入框等控件圆角）
 */

export const radius = {
  // session-glass 系列玻璃浮层圆角
  'glass-input': '24px', // .chat-input-glass
  'glass-sidebar': '12px', // .session-glass-sidebar / .session-list-item-active 侧栏列表项选中态
  'glass-rail': '12px', // .session-glass-rail
  'glass-tab': '14px', // 顶部标签：仅上边圆角，下边与 TabBar 相接
  'glass-chip': '6px', // .session-glass-chip
  'glass-modal': '20px', // .session-glass-modal
  'glass-modal-lg': '24px', // .session-glass-modal-lg
  'glass-popover': '12px', // .session-glass-popover / Select·Dropdown / ContextMenu
  'glass-sticky': '20px', // .session-glass-sticky 会话吸顶用户消息条
  'glass-tooltip': '10px', // .session-glass-tooltip：紧凑浮层，勿跟 composer 胶囊对齐

  // 通用控件圆角（暂用 Tailwind 默认值，未来可统一接管）
  // 'control-sm': '6px',
  // 'control': '8px',
  // 'control-lg': '12px',
} as const

export type RadiusToken = keyof typeof radius
