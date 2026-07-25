/**
 * 动效 Token 源
 *
 * 从 glass-studio 设计原型提取的动效 token。
 * 命名约定：`{duration|easing}-{modifier}`
 */

export const motion = {
  // 兼容旧原型命名；新代码优先使用 enter / exit / spatial。
  'ease-island': 'cubic-bezier(0.16, 1, 0.3, 1)',
  'ease-enter': 'cubic-bezier(0.16, 1, 0.3, 1)',
  'ease-exit': 'cubic-bezier(0.4, 0, 1, 1)',
  'ease-spatial': 'cubic-bezier(0.16, 1, 0.3, 1)',
  'spring-soft': 'cubic-bezier(0.22, 1, 0.36, 1)',

  // 语义时长：退出动画可在调用侧使用更短一级。
  'duration-instant': '100ms',
  'duration-fast': '160ms',
  'duration-control': '240ms',
  'duration-panel': '320ms',
  'duration-scene': '420ms',

  // 兼容旧 token。
  'duration-normal': '240ms',
  'duration-slow': '420ms',
} as const

export type MotionToken = keyof typeof motion
