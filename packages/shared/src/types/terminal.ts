/**
 * 内置终端 IPC 通道常量与请求/响应类型
 *
 * 渲染进程通过 window.electronAPI.terminal.* 调用，主进程在 main/lib/terminal-ipc.ts
 * 注册处理器。终端是真伪终端（node-pty）跑在主进程，输出经 IPC 流给渲染层用 xterm.js 渲染。
 *
 * 通道命名与 kanban/automation 一致：动词:名词 形式，data/exit 为 main→renderer 流。
 */

/** 单个渲染进程最多同时持有的终端会话数 */
export const TERMINAL_MAX_SESSIONS = 8
/** 单次 write 最大字节数（防御性上限，避免渲染层误传超大 payload） */
export const TERMINAL_MAX_DATA_WRITE_BYTES = 1_000_000
/** 切 tab/折叠面板时保留的输出环形缓冲大小（重放最近输出） */
export const TERMINAL_RING_BUFFER_BYTES = 64 * 1024
/** sessionId 最大长度（防御性上限） */
export const TERMINAL_MAX_SESSION_ID_LENGTH = 256
/** cwd 最大长度（防御性上限） */
export const TERMINAL_MAX_CWD_LENGTH = 4_096
/** 默认列数 */
export const TERMINAL_DEFAULT_COLS = 80
/** 默认行数 */
export const TERMINAL_DEFAULT_ROWS = 24
/** 列数上限 */
export const TERMINAL_MAX_COLS = 500
/** 行数上限 */
export const TERMINAL_MAX_ROWS = 200
/** 主 tab 的固定 id */
export const TERMINAL_MAIN_SESSION_ID = 'main'

export const TERMINAL_IPC_CHANNELS = {
  /** 创建（或重连）一个 PTY 会话 */
  CREATE: 'terminal:create',
  /** 向 PTY 写入用户输入 */
  WRITE: 'terminal:write',
  /** 调整 PTY 列/行 */
  RESIZE: 'terminal:resize',
  /** 销毁 PTY 会话（关 tab） */
  DISPOSE: 'terminal:dispose',
  /** PTY 输出流（main → renderer，每个数据块一条消息） */
  DATA: 'terminal:data',
  /** PTY 退出事件（main → renderer） */
  EXIT: 'terminal:exit',
} as const

/** 创建终端会话入参 */
export interface TerminalCreatePayload {
  /** 稳定的 PTY 会话标识，渲染端按工作区/标签页生成命名空间 */
  sessionId: string
  /** shell 工作目录，缺省回退到 OS home 目录 */
  cwd?: string
  cols?: number
  rows?: number
}

/** 写入终端入参 */
export interface TerminalWritePayload {
  sessionId: string
  /** 用户输入的原始字节（UTF-8 字符串） */
  data: string
}

/** 调整终端尺寸入参 */
export interface TerminalResizePayload {
  sessionId: string
  cols: number
  rows: number
}

/** main → renderer 输出流 payload */
export interface TerminalDataPayload {
  sessionId: string
  data: string
}

/** main → renderer 退出事件 payload */
export interface TerminalExitPayload {
  sessionId: string
  /** 进程退出码；非正常退出时为 null */
  exitCode: number | null
}

/** 创建终端返回结果 */
export type TerminalCreateResult =
  | { ok: true; sessionId: string; replayed?: boolean }
  | { ok: false; message: string }

// ===== 终端配色（native 模式跟 TAgent 主题深/浅走） =====

/**
 * 终端配色模式：native 跟 app 主题 / none 单色 / custom 自定义（本次先只用 native）
 *
 * native 模式下，背景/前景/光标/选区由渲染层从 TAgent 主题 CSS 变量
 *（--background / --foreground / --primary）读出实际 HSL 值组装后传入，
 * 使终端底色 = 会话信息流底色（信息流透明叠在 --background 上），文字色 = --foreground，
 * 深浅自动跟随 <html>.dark。ANSI 16 色保留彩色调色板（命令输出红绿蓝要能区分），
 * 仅深/浅切换调色板，不全用主题色（否则红绿警告看不出）。
 */
export type TerminalColorMode = 'native' | 'none' | 'custom'

/** 终端配色设置（本次先固定 native，保留结构供后续接设置） */
export interface TerminalColorSettings {
  colorMode: TerminalColorMode
  /** 终端底色（native 模式由渲染层从 --background 读出，对齐会话信息流底色） */
  background: string
  /** 终端文字色（native 模式由渲染层从 --foreground 读出） */
  foreground: string
  /** 光标色（native 模式 = 前景色） */
  cursor: string
  /** 选区背景色（native 模式由 --primary 派生半透明） */
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

/**
 * 内置深色预设（背景/前景/光标/选区）。
 * 仅作 fallback：当渲染层无法从 CSS 变量读出主题色时兜底，避免终端白屏。
 */
export const TERMINAL_PRESET_DARK = {
  background: '#151d31',
  foreground: '#e6e9ef',
  cursor: '#e6e9ef',
  selectionBackground: '#264f78aa',
} as const

/** 内置浅色预设（fallback 兜底用） */
export const TERMINAL_PRESET_LIGHT = {
  background: '#f3f5fc',
  foreground: '#1f2328',
  cursor: '#1f2328',
  selectionBackground: '#264f78aa',
} as const

/** 深色模式默认 ANSI 16 色调色板 */
export const TERMINAL_DEFAULT_ANSI_COLORS = {
  black: '#000000',
  red: '#ff6b6b',
  green: '#7ee787',
  yellow: '#f0c674',
  blue: '#6cb6ff',
  magenta: '#d2a8ff',
  cyan: '#56d4dd',
  white: '#e6e9ef',
  brightBlack: '#6b7280',
  brightRed: '#ffa198',
  brightGreen: '#9ee787',
  brightYellow: '#f9d57e',
  brightBlue: '#8cb6ff',
  brightMagenta: '#e0b3ff',
  brightCyan: '#7ce4ec',
  brightWhite: '#ffffff',
} as const

/** 浅色模式 ANSI 16 色调色板（native 模式浅色用） */
export const TERMINAL_NATIVE_LIGHT_ANSI_COLORS = {
  black: '#1f2328',
  red: '#cf222e',
  green: '#1a7f37',
  yellow: '#9a6700',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#57606a',
  brightBlack: '#6e7781',
  brightRed: '#a40e26',
  brightGreen: '#2da44e',
  brightYellow: '#bf8700',
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#3192aa',
  brightWhite: '#8c959f',
} as const

/**
 * 默认终端配色（native 模式 fallback）。
 * 用深色预设打底；渲染层（TerminalPanel）会在使用前用从 CSS 变量读出的
 * 主题色覆盖 background/foreground/cursor/selectionBackground。
 */
export function defaultTerminalColors(): TerminalColorSettings {
  return {
    colorMode: 'native',
    ...TERMINAL_PRESET_DARK,
    ...TERMINAL_DEFAULT_ANSI_COLORS,
  }
}

/** xterm.js theme 对象结构 */
export interface TerminalTheme {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
  /**
   * xterm.js 扩展调色板（ANSI 16-255）。仅在 none（单色）模式填充，
   * 把每个槽位映射到前景色，使 256 色序列也保持单色。custom/native 模式省略，
   * xterm.js 保留默认 256 色调色板。
   */
  extendedAnsi?: string[]
}

/**
 * 根据终端配色设置 + 当前深/浅模式，构建 xterm.js theme。
 *
 * - native 模式：背景/前景/光标/选区直接用传入的 colors（由渲染层从 TAgent
 *   主题 CSS 变量 --background/--foreground/--primary 读出组装），ANSI 16 色按
 *   深/浅切换调色板（保留彩色，命令输出红绿蓝可区分）。终端底色 = 会话信息流底色。
 * - none 模式：背景/前景用传入 colors，16 色 ANSI 全映射到前景色（单色）。
 * - custom 模式：直接用用户自定义色（本次未接设置，暂不走）。
 *
 * 不再沿父链合成 DOM surface 色：会话信息流自身背景透明，合成会塌成白/默认，
 * 改为信任传入的 colors.background（即主题 --background）。
 *
 * @param colors 终端配色设置（native 模式下 background/foreground 等应由渲染层
 *               从主题 CSS 变量读出后填入；未读出时用 fallback 预设兜底）
 * @param mode  'dark' / 'light'（来自 <html>.dark），仅用于切换 ANSI 调色板
 */
export function resolveTerminalTheme(
  colors: TerminalColorSettings,
  mode: 'dark' | 'light'
): TerminalTheme {
  if (colors.colorMode === 'custom') {
    return {
      background: colors.background,
      foreground: colors.foreground,
      cursor: colors.cursor,
      cursorAccent: colors.background,
      selectionBackground: colors.selectionBackground,
      black: colors.black,
      red: colors.red,
      green: colors.green,
      yellow: colors.yellow,
      blue: colors.blue,
      magenta: colors.magenta,
      cyan: colors.cyan,
      white: colors.white,
      brightBlack: colors.brightBlack,
      brightRed: colors.brightRed,
      brightGreen: colors.brightGreen,
      brightYellow: colors.brightYellow,
      brightBlue: colors.brightBlue,
      brightMagenta: colors.brightMagenta,
      brightCyan: colors.brightCyan,
      brightWhite: colors.brightWhite,
    }
  }

  if (colors.colorMode === 'native') {
    const ansi = mode === 'light' ? TERMINAL_NATIVE_LIGHT_ANSI_COLORS : TERMINAL_DEFAULT_ANSI_COLORS
    return {
      background: colors.background,
      foreground: colors.foreground,
      cursor: colors.foreground,
      cursorAccent: colors.background,
      selectionBackground: colors.selectionBackground,
      ...ansi,
    }
  }

  // none（单色）模式：16 色 ANSI 全映射到前景
  const foreground = colors.foreground
  return {
    background: colors.background,
    foreground,
    cursor: colors.foreground,
    cursorAccent: colors.background,
    selectionBackground: colors.selectionBackground,
    black: foreground,
    red: foreground,
    green: foreground,
    yellow: foreground,
    blue: foreground,
    magenta: foreground,
    cyan: foreground,
    white: foreground,
    brightBlack: foreground,
    brightRed: foreground,
    brightGreen: foreground,
    brightYellow: foreground,
    brightBlue: foreground,
    brightMagenta: foreground,
    brightCyan: foreground,
    brightWhite: foreground,
    // 8 位色序列（ESC[38;5;Nm）绕过 16 色命名，把扩展槽全映射到前景保持单色
    extendedAnsi: Array.from({ length: 240 }, () => foreground),
  }
}
