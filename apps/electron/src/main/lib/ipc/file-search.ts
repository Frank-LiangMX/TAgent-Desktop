/**
 * 裸文件名项目内查找 —— 文件 chip 的 resolveFile / openPath 兜底。
 *
 * Agent 回答里常只写 `main.cjs` / `Chat.tsx` 这类不带目录的文件名，
 * 按工作区根拼接必然解析失败，需要在项目内按名字找一遍。
 *
 * 两轮策略：首轮跳过构建产物目录（优先命中源文件），首轮无果再扫产物。
 * 全程跳过产物会让打包输出永远显示「文件不存在」——它确实存在，只是在 dist 里。
 */
import { existsSync, readdirSync, type Dirent } from 'node:fs'
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
  // 生成物/缓存目录（j3_statics 的 preview_cache 有 2.8 万项）
  'preview_cache',
  'preview-cache',
  '.preview-cache',
])

/** 构建产物目录：首轮跳过，第二轮才进 */
export const FILE_SEARCH_ARTIFACT_DIRS = new Set(['dist', 'build', 'out', '.next', 'target'])

/**
 * 单目录条目上限：readdir 结果超过即视为生成物/缓存目录，跳过不深入。
 *
 * 全局配额（FILE_SEARCH_MAX_FILES）会被单个爆炸目录瞬间吃光——
 * preview_cache 2.8 万项 > 8000 上限，按名搜索一进它就整体终止，
 * 排在其后的 py/、static/ 等真实源码目录永远扫不到（j3_statics 实测复现）。
 */
export const FILE_SEARCH_MAX_DIR_ENTRIES = 3000

/**
 * 扫描上限（超过放弃，防止超大项目阻塞主进程）。
 *
 * 实测本仓库排除依赖/版本控制后共 ~1900 个目录项、最深 7 层，一次完整未命中扫描约 13ms。
 * 深度只剩一层余量，源码再嵌一层就会静默扫不到，所以放宽到 12；
 * 条目数仍压在 8000（≈40ms/轮），保证最坏情况下主线程不会被拖住。
 */
export const FILE_SEARCH_MAX_FILES = 8000
export const FILE_SEARCH_MAX_DEPTH = 12

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
    // 单目录条目爆炸（preview_cache 这类 2 万+ 生成物目录）会瞬间吃光全局配额，
    // 导致排在其后的真实源码目录永远扫不到——超过阈值整体跳过（本层文件仍可比对）。
    const isHugeDir = entries.length > FILE_SEARCH_MAX_DIR_ENTRIES
    // 先比完本层文件再下潜：同名文件优先命中更浅的那个，也避免深目录抢先
    const subdirs: string[] = []
    for (const entry of entries) {
      if (scanned++ > FILE_SEARCH_MAX_FILES) return null
      if (entry.isDirectory()) {
        if (FILE_SEARCH_SKIP_DIRS.has(entry.name)) continue
        if (!includeArtifacts && FILE_SEARCH_ARTIFACT_DIRS.has(entry.name)) continue
        if (isHugeDir) continue
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

// ===== 查找结果缓存 =====

/** 命中缓存有效期；过期或文件已消失都会重扫 */
export const FILE_SEARCH_CACHE_TTL_MS = 60_000

const hitCache = new Map<string, { path: string; at: number }>()

function cacheKey(root: string, fileName: string): string {
  return `${root}\0${fileName.toLowerCase()}`
}

/**
 * 带缓存的按名查找。
 *
 * 只缓存命中：未命中往往是「Agent 刚说要建、还没落盘」的时序问题，
 * 缓存 null 会把文件 chip 在整个 TTL 内锁死成「文件不存在」。
 * 命中项在复用前再 existsSync 一次，避免文件被移走后一直返回旧路径。
 */
export function findFileByNameCached(root: string, fileName: string): string | null {
  const key = cacheKey(root, fileName)
  const cached = hitCache.get(key)
  if (cached && Date.now() - cached.at < FILE_SEARCH_CACHE_TTL_MS) {
    if (existsSync(cached.path)) return cached.path
    hitCache.delete(key)
  }
  const found = findFileByName(root, fileName)
  if (found) hitCache.set(key, { path: found, at: Date.now() })
  return found
}

/** 清空查找缓存（测试与工作区切换用） */
export function clearFileSearchCache(): void {
  hitCache.clear()
}
