/**
 * 文件路径工具函数
 *
 * 从 file-path-chip.tsx 提取的纯逻辑函数，
 * 供 @tagent/ui 和应用层共同使用。
 */

/** 图片扩展名 */
export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'])

/** 视频扩展名 */
export const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov'])

/**
 * 代码/结构化文本扩展名
 * 需与主进程 file-preview-service.ts 的 CODE_EXTENSIONS + MARKDOWN_EXTENSIONS 保持一致
 */
export const CODE_EXTS = new Set([
  'md',
  'markdown',
  'json',
  'jsonc',
  'json5',
  'xml',
  'html',
  'htm',
  'txt',
  'log',
  'csv',
  'yaml',
  'yml',
  'toml',
  'ini',
  'env',
  'lock',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'sh',
  'bash',
  'zsh',
  'fish',
  'css',
  'scss',
  'less',
  'sql',
  'rb',
  'php',
  'diff',
  'patch',
])

/** 文档扩展名 */
export const DOC_EXTS = new Set(['pdf', 'docx'])

/** 所有可预览的扩展名集合 */
export const ALL_PREVIEWABLE_EXTS = new Set([
  ...IMAGE_EXTS,
  ...VIDEO_EXTS,
  ...CODE_EXTS,
  ...DOC_EXTS,
])

/** 文件存在性缓存（模块级共享） */
const fileExistsCache = new Map<string, boolean>()

export function existsCacheKey(filePath: string, bases: string[]): string {
  return `${filePath}\0${bases.join('\0')}`
}

export function getFileExistsCache(): Map<string, boolean> {
  return fileExistsCache
}

/** 从路径提取文件名（兼容 POSIX `/` 与 Windows `\`） */
export function getFileName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const parts = normalized.split('/')
  return parts[parts.length - 1] || filePath
}

/** 从文件名提取扩展名（小写，不含点） */
export function getExtension(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot === -1) return ''
  return filename.slice(dot + 1).toLowerCase()
}

/**
 * 将 MSYS/Git Bash 挂载风格路径（/f/TAgent-Desktop/a.ts、/c/Users/x/a.ts）转换为
 * Windows 盘符路径（F:\TAgent-Desktop\a.ts）。非该形态返回 null。
 *
 * Windows 上 kscc 的 Bash 工具经 Git Bash 执行，输出路径常带单字母盘符挂载前缀，
 * win32 会把 /f/... 解析到当前盘根的 f 目录（必然不存在）——解析前先转换。
 */
export function msysPathToWindowsDrivePath(filePath: string): string | null {
  const m = /^\/([a-zA-Z])\/(.+)$/.exec(filePath.trim())
  if (!m) return null
  // 剩余部分统一反斜杠（Windows 分隔符；路径中的 / 只可能是分隔符）
  return `${m[1]!.toUpperCase()}:\\${m[2]!.replace(/\//g, '\\')}`
}

/**
 * 从路径中剥离末尾的行号/列号后缀（如 :42 或 :42:15）
 */
export function stripLineCol(filePath: string): { path: string; suffix: string } {
  const m = filePath.match(/^(.+?)(:\d+(?::\d+)?)$/)
  if (m && !m[1]!.endsWith(':')) {
    return { path: m[1]!, suffix: m[2]! }
  }
  return { path: filePath, suffix: '' }
}

/**
 * 检测文本是否为绝对文件路径
 *
 * Windows 同时接受：
 * - 盘符大小写：`C:\` / `c:\`
 * - 分隔符：`\` / `/`（如 `F:/proj/a.ts`）
 * - UNC：`\\server\share\...`
 */
export function isAbsoluteFilePath(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 2) return false

  const { path: clean } = stripLineCol(trimmed)

  if (clean.startsWith('/') && /^\/[^\n]+\/[^\n]+$/.test(clean)) {
    if (clean.endsWith('/') && !clean.includes('.')) return false
    return true
  }

  // Windows 盘符绝对路径（大小写 + 正/反斜杠）
  if (/^[A-Za-z]:[\\/]/.test(clean)) return true

  // UNC 路径
  if (clean.startsWith('\\\\')) return true

  return false
}

/**
 * 检测文本是否为相对文件路径（需要 basePath 才有意义）
 */
export function isRelativeFilePath(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 3) return false

  const { path: clean } = stripLineCol(trimmed)

  const ext = getExtension(clean)
  if (!ext || !ALL_PREVIEWABLE_EXTS.has(ext)) return false

  // Windows Agent 输出反斜杠相对路径（py\parse_mesh.py）也要能识别
  if (!/^[\w./@\\-]+$/.test(clean)) return false

  if (clean.startsWith('.') && !clean.startsWith('./') && !clean.includes('/')) return false

  return true
}
