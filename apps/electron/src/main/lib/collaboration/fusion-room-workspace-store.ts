import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  FusionRoomWorkspaceCommitTransaction,
  FusionRoomWorkspaceStore,
} from '@tagent/core'
import { getCollaborationRoomWorkspaceDir } from '../config/config-paths'
import { runWorkspaceCommand, type WorkspaceCommandRunResult } from './workspace-command-runner'

const MAX_FILE_BYTES = 32 * 1024 * 1024

export interface FileFusionRoomWorkspaceStoreOptions {
  rootForRoom?: (roomId: string) => string
  maxFileBytes?: number
}

/**
 * Materializes the authoritative RoomWorkspace into a room-scoped directory.
 *
 * prepareCommit writes only a temporary file. The Host calls commit after the
 * authority has accepted the lock/SHA transition; rollback restores the prior
 * file if a later snapshot write fails.
 */
export class FileFusionRoomWorkspaceStore implements FusionRoomWorkspaceStore {
  private readonly rootForRoom: (roomId: string) => string
  private readonly maxFileBytes: number

  constructor(options: FileFusionRoomWorkspaceStoreOptions = {}) {
    this.rootForRoom = options.rootForRoom ?? getCollaborationRoomWorkspaceDir
    this.maxFileBytes = Math.max(1, options.maxFileBytes ?? MAX_FILE_BYTES)
  }

  prepareCommit(input: {
    roomId: string
    relativePath: string
    content: string
  }): FusionRoomWorkspaceCommitTransaction {
    const finalPath = this.resolveSafePath(input.roomId, input.relativePath)
    const contentBytes = Buffer.byteLength(input.content, 'utf8')
    if (contentBytes > this.maxFileBytes) {
      throw new Error('工作区文件超过大小上限')
    }
    const parent = dirname(finalPath)
    // 先检查现有路径，再创建目录或读取旧文件；避免通过已有符号链接触碰房间外内容。
    this.assertNoSymlinkPath(input.roomId, input.relativePath, finalPath)
    mkdirSync(parent, { recursive: true })
    // 对 mkdir 之后的路径再检查一次，覆盖并发创建链接的窗口。
    this.assertNoSymlinkPath(input.roomId, input.relativePath, finalPath)

    const existed = existsSync(finalPath)
    const previous = existed ? readFileSync(finalPath, 'utf8') : undefined
    const tempPath = join(parent, '.tagent-tmp-' + randomUUID() + '.part')
    writeFileSync(tempPath, input.content, { encoding: 'utf8', flag: 'wx' })
    let committed = false
    let rolledBack = false

    return {
      commit: () => {
        if (rolledBack) throw new Error('工作区提交事务已经回滚')
        if (committed) return
        renameSync(tempPath, finalPath)
        committed = true
      },
      rollback: () => {
        if (rolledBack) return
        rolledBack = true
        try {
          if (existsSync(tempPath)) unlinkSync(tempPath)
        } catch {
          // best effort cleanup
        }
        if (!committed) return
        try {
          if (previous === undefined) {
            if (existsSync(finalPath)) unlinkSync(finalPath)
          } else {
            const restorePath = join(parent, '.tagent-restore-' + randomUUID() + '.part')
            writeFileSync(restorePath, previous, { encoding: 'utf8', flag: 'wx' })
            renameSync(restorePath, finalPath)
          }
        } catch {
          // The atomic replacement either restored the old content or left the new
          // version; the audit snapshot remains authoritative for retry/recovery.
        }
      },
    }
  }

  prepareDelete(input: { roomId: string; relativePath: string }): FusionRoomWorkspaceCommitTransaction {
    const finalPath = this.resolveSafePath(input.roomId, input.relativePath)
    this.assertNoSymlinkPath(input.roomId, input.relativePath, finalPath)
    if (!existsSync(finalPath)) throw new Error('工作区文件不存在')
    const stat = lstatSync(finalPath)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('只允许删除普通文件')
    let committed = false
    let rolledBack = false
    return {
      commit: () => {
        if (rolledBack) throw new Error('工作区删除事务已经回滚')
        if (committed) return
        if (!existsSync(finalPath) || !lstatSync(finalPath).isFile()) throw new Error('工作区文件在提交前发生变化')
        unlinkSync(finalPath)
        committed = true
      },
      rollback: () => {
        if (rolledBack) return
        rolledBack = true
        // 删除事务在提交前没有写入；实际 Host 回滚只需保留现状。
      },
    }
  }

  prepareMove(input: { roomId: string; fromPath: string; toPath: string }): FusionRoomWorkspaceCommitTransaction {
    const fromPath = this.resolveSafePath(input.roomId, input.fromPath)
    const toPath = this.resolveSafePath(input.roomId, input.toPath)
    this.assertNoSymlinkPath(input.roomId, input.fromPath, fromPath)
    this.assertNoSymlinkPath(input.roomId, input.toPath, toPath)
    if (!existsSync(fromPath)) throw new Error('源工作区文件不存在')
    const source = lstatSync(fromPath)
    if (source.isSymbolicLink() || !source.isFile()) throw new Error('源路径必须是普通文件')
    if (existsSync(toPath)) throw new Error('目标路径已存在，拒绝覆盖')
    const parent = dirname(toPath)
    if (!existsSync(parent) || !lstatSync(parent).isDirectory()) throw new Error('目标父目录不存在')
    let committed = false
    let rolledBack = false
    return {
      commit: () => {
        if (rolledBack) throw new Error('工作区移动事务已经回滚')
        if (committed) return
        if (existsSync(toPath)) throw new Error('目标路径在提交前已存在')
        renameSync(fromPath, toPath)
        committed = true
      },
      rollback: () => {
        if (rolledBack) return
        rolledBack = true
        if (!committed) return
        try {
          if (existsSync(toPath) && !existsSync(fromPath)) renameSync(toPath, fromPath)
        } catch {
          // The authority snapshot remains the source of truth for recovery.
        }
      },
    }
  }
  readFile(roomId: string, relativePath: string): string | undefined {
    const path = this.resolveSafePath(roomId, relativePath)
    this.assertNoSymlinkPath(roomId, relativePath, path)
    if (!existsSync(path)) return undefined
    const stat = lstatSync(path)
    if (!stat.isFile()) throw new Error('工作区目标不是普通文件')
    if (stat.size > this.maxFileBytes) throw new Error('工作区文件超过读取上限')
    return readFileSync(path, 'utf8')
  }

  runCommand(input: {
    roomId: string
    command: string
    args?: string
    cwd?: string
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<WorkspaceCommandRunResult> {
    const root = resolve(this.rootForRoom(input.roomId))
    let runCwd = root
    const trimmed = (input.cwd ?? '').trim()
    if (trimmed && trimmed !== '.' && trimmed !== './') {
      runCwd = this.resolveSafePath(input.roomId, trimmed)
      if (!existsSync(runCwd) || !lstatSync(runCwd).isDirectory()) {
        return Promise.resolve({ ok: false, reason: 'cwd 目录不存在或不是目录' })
      }
    }
    if (existsSync(runCwd) && lstatSync(runCwd).isSymbolicLink()) {
      return Promise.resolve({ ok: false, reason: 'cwd 不能是符号链接' })
    }
    return runWorkspaceCommand(input.command, input.args, {
      cwd: runCwd,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    })
  }
  searchFiles(
    roomId: string,
    relativePath: string,
    pattern?: string,
    maxResults = 200,
  ): { paths: string[]; truncated: boolean } {
    const root = resolve(this.rootForRoom(roomId))
    const trimmed = (relativePath ?? '').trim()
    let base = root
    let baseRelative = ''
    if (trimmed && trimmed !== '.' && trimmed !== './') {
      base = this.resolveSafePath(roomId, trimmed)
      baseRelative = trimmed
    }
    if (!existsSync(base)) return { paths: [], truncated: false }
    if (lstatSync(base).isSymbolicLink()) throw new Error('搜索路径不能是符号链接')
    if (!lstatSync(base).isDirectory()) {
      const name = baseRelative.split('/').pop() ?? ''
      return (!pattern || simpleWorkspacePattern(pattern, name))
        ? { paths: [baseRelative], truncated: false }
        : { paths: [], truncated: false }
    }
    const limit = Math.min(500, Math.max(1, Math.floor(maxResults)))
    const paths: string[] = []
    let truncated = false
    const walk = (dir: string, relDir: string, depth: number): void => {
      if (depth > 32 || truncated) return
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = relDir ? relDir + '/' + entry.name : entry.name
        const full = join(dir, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          walk(full, rel, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        if (pattern && !simpleWorkspacePattern(pattern, entry.name)) continue
        paths.push(rel)
        if (paths.length >= limit) {
          truncated = true
          return
        }
      }
    }
    walk(base, baseRelative, 0)
    return { paths, truncated }
  }

  private resolveSafePath(roomId: string, relativePath: string): string {
    const root = resolve(this.rootForRoom(roomId))
    const raw = relativePath.trim()
    if (
      !raw ||
      raw.includes('\0') ||
      raw.includes('\\') ||
      raw.startsWith('/') ||
      raw.startsWith('//') ||
      /^[A-Za-z]:/.test(raw)
    ) {
      throw new Error('工作区路径必须是安全的相对路径')
    }
    const parts = raw.split('/')
    if (parts.some((part) => !part || part === '.' || part === '..')) {
      throw new Error('工作区路径不能包含 .、.. 或空路径段')
    }
    const target = resolve(root, ...parts)
    const outside = relative(root, target)
    if (isAbsolute(outside) || outside.startsWith('..' + sep) || outside === '..') {
      throw new Error('工作区路径越界')
    }
    return target
  }

  private assertNoSymlinkPath(roomId: string, relativePath: string, target: string): void {
    const root = resolve(this.rootForRoom(roomId))
    if (existsSync(root) && lstatSync(root).isSymbolicLink()) {
      throw new Error('工作区根目录不能是符号链接')
    }
    const rootReal = existsSync(root) ? resolve(root) : root
    const parts = relativePath.split('/')
    let current = root
    for (let i = 0; i < parts.length; i += 1) {
      current = join(current, parts[i]!)
      if (!existsSync(current)) continue
      const stat = lstatSync(current)
      if (stat.isSymbolicLink()) throw new Error('工作区路径不能经过符号链接')
    }
    const parent = dirname(target)
    if (existsSync(parent)) {
      const parentReal = resolve(parent)
      const outside = relative(rootReal, parentReal)
      if (isAbsolute(outside) || outside.startsWith('..' + sep) || outside === '..') {
        throw new Error('工作区父目录越界')
      }
    }
  }
}

function simpleWorkspacePattern(pattern: string, value: string): boolean {
  const p = pattern.toLowerCase()
  const v = value.toLowerCase()
  let pi = 0
  let vi = 0
  let star = -1
  let checkpoint = 0
  while (vi < v.length) {
    if (pi < p.length && (p[pi] === '?' || p[pi] === v[vi])) { pi += 1; vi += 1; continue }
    if (pi < p.length && p[pi] === '*') { star = pi++; checkpoint = vi; continue }
    if (star >= 0) { pi = star + 1; vi = ++checkpoint; continue }
    return false
  }
  while (pi < p.length && p[pi] === '*') pi += 1
  return pi === p.length
}
