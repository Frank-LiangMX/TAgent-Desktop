/**
 * 裸文件名项目内查找 —— 文件 chip 的 resolveFile / openPath 兜底。
 *
 * Agent 回答里常只写 `main.cjs` / `Chat.tsx` 这类不带目录的文件名，
 * 按工作区根拼接必然解析失败，需要在项目内按名字找一遍。
 *
 * 两轮策略：首轮跳过构建产物目录（优先命中源文件），首轮无果再扫产物。
 * 全程跳过产物会让打包输出永远显示「文件不存在」——它确实存在，只是在 dist 里。
 */
import { readdirSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

/** 永远跳过：依赖 / 版本控制 / 缓存，体量大且不会是用户想指的文件 */
export const FILE_SEARCH_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.bun-cache',
  '.worktrees',
  '.cache',
  'coverage',
  '.venv',
  'venv',
])

/** 构建产物目录：首轮跳过，第二轮才进 */
export const FILE_SEARCH_ARTIFACT_DIRS = new Set(['dist', 'build', 'out', '.next', 'target'])

/** 扫描文件数上限（超过放弃，防止超大项目阻塞主进程） */
export const FILE_SEARCH_MAX_FILES = 8000
export const FILE_SEARCH_MAX_DEPTH = 8

/** 单轮扫描：includeArtifacts 决定是否进入 dist/build/out 这类产物目录 */
function searchFileByName(
  root: string,
  fileName: string,
  includeArtifacts: boolean,
): string | null {
  const target = fileName.toLowerCase()
  let scanned = 0

  const walk = (dir: string, depth: number): string | null => {
    if (depth > FILE_SEARCH_MAX_DEPTH || scanned > FILE_SEARCH_MAX_FILES) return null
    let entries: Dirent[] = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return null
    }
    // 先比完本层文件再下潜：同名文件优先命中更浅的那个，也避免深目录抢先
    const subdirs: string[] = []
    for (const entry of entries) {
      if (scanned++ > FILE_SEARCH_MAX_FILES) return null
      if (entry.isDirectory()) {
        if (FILE_SEARCH_SKIP_DIRS.has(entry.name)) continue
        if (!includeArtifacts && FILE_SEARCH_ARTIFACT_DIRS.has(entry.name)) continue
        subdirs.push(join(dir, entry.name))
      } else if (entry.name.toLowerCase() === target) {
        return join(dir, entry.name)
      }
    }
    for (const sub of subdirs) {
      const hit = walk(sub, depth + 1)
      if (hit) return hit
    }
    return null
  }

  return walk(root, 0)
}

/** 在根目录下按文件名递归查找（不区分大小写），返回绝对路径或 null */
export function findFileByName(root: string, fileName: string): string | null {
  return searchFileByName(root, fileName, false) ?? searchFileByName(root, fileName, true)
}
