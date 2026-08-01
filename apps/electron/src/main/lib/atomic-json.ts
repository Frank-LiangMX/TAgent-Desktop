/**
 * 原子 JSON 持久化（自研）
 *
 * 解决「整体覆盖式」JSON 文件写一半崩溃 → 文件损坏的问题：
 * 1. 内容写临时文件 + fsync
 * 2. 旧文件 rename 备份为 .bak
 * 3. 临时文件 rename 原子替换为正式文件
 *
 * 读损坏自愈：主文件解析失败 → 从 .bak 恢复；备份也坏则保留 .corrupt 并返回 fallback。
 * 串行化：per-path Promise 链，防并发覆盖。
 *
 * 设计文档：docs/plans/2026-07-31-persistent-safety.md
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'

/** 三步原子写。失败时清理临时文件并尝试回滚备份。 */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  const bakPath = `${filePath}.bak`

  try {
    // 1) 写临时文件并落盘
    const fd = openSync(tmpPath, 'w')
    try {
      writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }

    // 2) 备份旧文件（Windows rename 不覆盖已存在目标，先清旧备份）
    if (existsSync(filePath)) {
      try {
        rmSync(bakPath, { force: true })
      } catch {
        /* 旧备份删不掉不致命 */
      }
      renameSync(filePath, bakPath)
    }

    // 3) 原子替换
    renameSync(tmpPath, filePath)
  } catch (error) {
    try {
      rmSync(tmpPath, { force: true })
    } catch {
      /* ignore */
    }
    // 替换失败但已备份 → 回滚
    if (!existsSync(filePath) && existsSync(bakPath)) {
      try {
        renameSync(bakPath, filePath)
      } catch {
        /* ignore */
      }
    }
    throw error
  }
}

/**
 * 损坏自愈读取：主文件解析失败 → 从 .bak 恢复（并原子写回）；
 * 备份也失败则保留 `.corrupt` 供排查，返回 fallback。
 */
export function readJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    if (!existsSync(filePath)) return fallback
    return JSON.parse(readFileSync(filePath, 'utf8')) as T
  } catch {
    const bakPath = `${filePath}.bak`
    try {
      if (existsSync(bakPath)) {
        const parsed = JSON.parse(readFileSync(bakPath, 'utf8')) as T
        try {
          writeJsonAtomic(filePath, parsed)
          console.warn(`[atomic-json] ${filePath} 损坏，已从备份恢复`)
        } catch {
          /* 恢复写回失败不阻断返回 */
        }
        return parsed
      }
    } catch (error) {
      console.warn(`[atomic-json] ${filePath} 备份恢复失败:`, error)
    }
    try {
      if (existsSync(filePath)) renameSync(filePath, `${filePath}.corrupt`)
    } catch {
      /* ignore */
    }
    return fallback
  }
}

/** 串行化写入器：per-path Promise 链，防多处并发覆盖同一文件 */
export function createSerialJsonWriter(filePath: string): (data: unknown) => Promise<void> {
  let chain: Promise<void> = Promise.resolve()
  return (data: unknown): Promise<void> => {
    chain = chain.then(() => {
      writeJsonAtomic(filePath, data)
    })
    return chain
  }
}
