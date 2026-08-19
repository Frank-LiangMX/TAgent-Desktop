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

/**
 * 统一路径分隔符：Windows 反斜杠归一为 POSIX `/`。
 *
 * REGRESS-J(J6)：Agent 输出常混用分隔符（如 `D:\proj/a.ts`、`basePath=D:\UnrealTagManager`
 * + `Foo/Bar.h`）。解析/存在性检查前先归一，避免拼接出 `D:\UnrealTagManager/Foo/Bar.h`
 * 这类混分隔符路径，也让 existsCacheKey 对同一文件的不同分隔符写法命中同一缓存键。
 */
export function normalizeFilePathSeparators(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

/**
 * 拼接 base 目录 + 相对路径，返回分隔符统一的绝对路径（供存在性检查与显示）。
 * 例：`joinBasePath('D:\\UnrealTagManager', 'Foo/Bar.h')` → `D:/UnrealTagManager/Foo/Bar.h`。
 */
export function joinBasePath(base: string, relativePath: string): string {
  const b = normalizeFilePathSeparators(base).replace(/\/+$/, '')
  const r = normalizeFilePathSeparators(relativePath).replace(/^\/+/, '')
  return r ? `${b}/${r}` : b
}

/** 存在性缓存键：入参与 base 都先归一，混用分隔符的写法映射到同一键 */
export function existsCacheKey(filePath: string, bases: string[]): string {
  const normPath = normalizeFilePathSeparators(filePath)
  const normBases = bases.map((b) => normalizeFilePathSeparators(b))
  return `${normPath}\0${normBases.join('\0')}`
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
 * 清洗 Agent / 工具给出的路径：去引号、file://、行号后缀、首尾空白。
 * Files Changed / resolveFile 共用，避免 `"./a.ts"`、`file:///C:/a.ts:12` 解析到了却读失败。
 */
export function cleanFilePathInput(filePath: string): string {
  let s = filePath.trim()
  if (!s) return s
  // 包裹引号
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    s = s.slice(1, -1).trim()
  }
  // file:// 或 file:///C:/...
  if (/^file:/i.test(s)) {
    try {
      // Windows file:///C:/x → pathname /C:/x；用 URL 解析再剥前导斜杠
      const u = new URL(s)
      let pathname = decodeURIComponent(u.pathname || '')
      if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1)
      s = pathname || s
    } catch {
      s = s.replace(/^file:\/\//i, '')
      if (/^\/[A-Za-z]:\//.test(s)) s = s.slice(1)
    }
  }
  s = stripLineCol(s).path.trim()
  return s
}

/**
 * 截断占位路径（`D:/proj/...`、`src/…/a.ts`）：不是真实文件，勿升 FileChip。
 * Agent / 用户常把长路径写成省略号摘要。
 */
function isEllipsisPlaceholderPath(clean: string): boolean {
  return /(?:^|[\\/])\.\.\.(?:[\\/]|$)/.test(clean) || clean.includes('…')
}

/** 路径末段是否像可打开的文件；纯目录 / 版本号文件夹返回 false */
function basenameLooksLikeFile(filePath: string): boolean {
  const name = getFileName(stripLineCol(filePath).path)
  if (!name || name === '.' || name === '..') return false
  // .env / .gitignore：点文件当文件
  if (name.startsWith('.') && name.length > 1 && !name.endsWith('.')) return true
  const ext = getExtension(name)
  if (!ext) return false
  // UE_5.8 / v1.2.3：末段纯数字是版本目录，不是扩展名
  if (/^\d+$/.test(ext)) return false
  return ALL_PREVIEWABLE_EXTS.has(ext)
}

/**
 * 检测文本是否为绝对文件路径
 *
 * - 盘符大小写：`C:\` / `c:\`
 * - 分隔符：`\` / `/`（如 `F:/proj/a.ts`）
 * - UNC：`\\server\share\...`
 *
 * 末段不是可预览文件（目录 / 工作区 / 版本号如 `UE_5.8`）→ false，勿升 FileChip。
 * POSIX：拒绝 API/URL 风格路径（如 `/v1/messages`、`/api/foo`）。
 */
export function isAbsoluteFilePath(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 2) return false

  const { path: clean } = stripLineCol(trimmed)
  if (isEllipsisPlaceholderPath(clean)) return false
  if (!basenameLooksLikeFile(clean)) return false

  if (clean.startsWith('/')) {
    // Anthropic `/v1/messages`、REST `/api/...` 等：不是本地文件
    if (isApiStyleAbsolutePath(clean)) return false
    // 至少两段（/a/b）；目录尾斜杠 → 不当文件
    if (!/^\/[^\n]+\/[^\n]+$/.test(clean)) return false
    if (clean.endsWith('/')) return false
    return true
  }

  // Windows 盘符绝对路径（大小写 + 正/反斜杠）
  if (/^[A-Za-z]:[\\/]/.test(clean)) return true

  // UNC 路径
  if (clean.startsWith('\\\\')) return true

  return false
}

/** `/v1/...`、`/api/...` 等 HTTP API 路径，不应升 FileChip */
function isApiStyleAbsolutePath(clean: string): boolean {
  return /^\/(?:v\d+|api|graphql|oauth|rest|rpc|healthz?|status|webhook)(?:\/|$)/i.test(clean)
}

/**
 * 检测文本是否为相对文件路径（需要 basePath 才有意义）
 */
export function isRelativeFilePath(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 3) return false

  const { path: clean } = stripLineCol(trimmed)
  if (isEllipsisPlaceholderPath(clean)) return false

  const ext = getExtension(clean)
  if (!ext || !ALL_PREVIEWABLE_EXTS.has(ext)) return false

  // Windows Agent 输出反斜杠相对路径（py\parse_mesh.py）也要能识别
  if (!/^[\w./@\\-]+$/.test(clean)) return false

  if (clean.startsWith('.') && !clean.startsWith('./') && !clean.includes('/')) return false

  return true
}

/** 文件类型徽章色调（与 TurnFilesChangedCard / FilePathChip 共用） */
export type FileLangBadgeTone = 'react' | 'ts' | 'css' | 'md' | 'code' | 'text'

/**
 * 由文件名推导语言/类型徽章（≤2 字标签 + 色调）。
 * 避免 FilePathChip 用文件名首字母（c/M/i）被误读成 git status。
 */
export function fileLangBadgeForName(name: string): { label: string; tone: FileLangBadgeTone } {
  const lower = name.toLowerCase()
  const ext = (lower.includes('.') ? lower.split('.').pop() : '') || ''
  if (ext === 'tsx' || ext === 'jsx') return { label: 'R', tone: 'react' }
  if (ext === 'ts' || ext === 'mts' || ext === 'cts') return { label: 'TS', tone: 'ts' }
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return { label: 'JS', tone: 'ts' }
  if (ext === 'css' || ext === 'scss' || ext === 'less') return { label: '#', tone: 'css' }
  if (ext === 'md' || ext === 'mdc' || ext === 'mdx') return { label: 'MD', tone: 'md' }
  if (ext === 'cpp' || ext === 'cc' || ext === 'cxx') return { label: 'C+', tone: 'code' }
  if (ext === 'hpp' || ext === 'hh' || ext === 'h') return { label: 'H', tone: 'code' }
  if (ext === 'c') return { label: 'C', tone: 'code' }
  if (ext === 'cs' || lower.endsWith('.build.cs')) return { label: 'C#', tone: 'code' }
  if (ext === 'py') return { label: 'PY', tone: 'code' }
  if (ext === 'go') return { label: 'GO', tone: 'code' }
  if (ext === 'rs') return { label: 'RS', tone: 'code' }
  if (ext === 'json' || ext === 'jsonc') return { label: '{}', tone: 'text' }
  return { label: '·', tone: 'text' }
}
