/**
 * 附件服务 — 文件持久化到磁盘
 *
 * 存储路径：~/.tagent[-dev]/attachments/{sessionId}/{uuid}.{ext}
 * 参考 Proma attachment-service.ts，适配 TAgent 数据目录。
 */
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { getConfigDir } from './config/config-paths'
import { rmSyncRobust } from './fs-robust'

/** 附件根目录：~/.tagent[-dev]/attachments/ */
function getAttachmentsDir(): string {
  const dir = join(getConfigDir(), 'attachments')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** 会话附件目录：~/.tagent[-dev]/attachments/{sessionId}/ */
function getSessionAttachmentsDir(sessionId: string): string {
  const dir = join(getAttachmentsDir(), sessionId)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** 解析附件绝对路径（安全检查：必须在 attachments 目录内） */
function resolveAttachmentPath(localPath: string): string {
  const resolved = join(getAttachmentsDir(), localPath)
  const attachmentsDir = getAttachmentsDir()
  if (!resolved.startsWith(attachmentsDir)) {
    throw new Error(`[attachment-service] 路径越界: ${localPath}`)
  }
  return resolved
}

export interface FileAttachment {
  id: string
  filename: string
  mediaType: string
  localPath: string
  size: number
}

export interface AttachmentSaveInput {
  sessionId: string
  filename: string
  mediaType: string
  data: string // base64
}

/**
 * 保存附件到磁盘
 * @returns FileAttachment（localPath 为相对路径 {sessionId}/{uuid}.{ext}）
 */
export function saveAttachment(input: AttachmentSaveInput): FileAttachment {
  const ext = extname(input.filename) || '.bin'
  const id = randomUUID()
  const storedFilename = `${id}${ext}`
  const dir = getSessionAttachmentsDir(input.sessionId)
  const filePath = join(dir, storedFilename)

  const buffer = Buffer.from(input.data, 'base64')
  writeFileSync(filePath, buffer)

  return {
    id,
    filename: input.filename,
    mediaType: input.mediaType,
    localPath: `${input.sessionId}/${storedFilename}`,
    size: buffer.length,
  }
}

/** 读取附件为 base64 */
export function readAttachmentAsBase64(localPath: string): string {
  const filePath = resolveAttachmentPath(localPath)
  if (!existsSync(filePath)) {
    throw new Error(`[attachment-service] 文件不存在: ${localPath}`)
  }
  const buffer = readFileSync(filePath)
  return buffer.toString('base64')
}

/** 附件绝对路径（供注入 prompt / Read 工具；越界抛错） */
export function getAttachmentAbsolutePath(localPath: string): string {
  return resolveAttachmentPath(localPath)
}

/**
 * target 是否严格位于 parent 之内（不含 parent 自身）。
 * 经 resolve 后 `..` 已折叠，再用 relative 判定，可拒绝绝对路径穿越。
 * 与 kb-fs-index 的 isWithinRoot 同构。
 */
function isWithinParent(parent: string, target: string): boolean {
  const rel = relative(parent, target)
  if (rel === '') return false // target === parent 本身（目录），非文件
  return !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * 解析「当前会话」附件的绝对路径，强制会话隔离（kb_read_attachment 用）。
 *
 * 接受相对 localPath（标准存储形 `{sessionId}/{uuid}.{ext}`，或裸 `{uuid}.{ext}`），
 * 解析后必须严格落在 `attachments/{sessionId}/` 之内。拒绝：
 * - 绝对路径、空路径
 * - 路径穿越（`..` 折叠后逃出会话目录）
 * - 其它会话的附件（第一段不是当前 sessionId 且不在本会话目录内）
 * - 符号链接逃逸（realpath 后跑到会话目录之外）
 * - 不存在 / 非常规文件
 *
 * 注意：与 {@link resolveAttachmentPath} 不同——后者只校验落在 attachments 根下，
 * 不区分会话；本函数额外钉死当前 sessionId，故 kb_read_attachment 不能偷读他局附件。
 *
 * @returns 安全的绝对路径（已通过 realpath + isFile 校验）；任何违规返回 null（由调用方转 error JSON）
 */
export function resolveSessionAttachmentPath(
  sessionId: string,
  localPath: string,
): string | null {
  const sid = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (!sid) return null
  const raw = typeof localPath === 'string' ? localPath.trim() : ''
  if (!raw || isAbsolute(raw)) return null

  // 统一分隔符后判定解析基：标准形以 `{sessionId}/` 开头 → 相对 attachments 根；
  // 裸文件名 → 相对当前会话目录。最终都以 isWithinParent(sessionDir, …) 兜底。
  const normalized = raw.replace(/\\/g, '/')
  const attachmentsDir = getAttachmentsDir()
  const sessionDir = join(attachmentsDir, sid)
  const resolved =
    normalized === sid || normalized.startsWith(sid + '/')
      ? resolve(attachmentsDir, normalized)
      : resolve(sessionDir, normalized)
  if (!isWithinParent(sessionDir, resolved)) return null

  // lexical 包含不足以抵御中间目录 / 文件本身的符号链接；realpath 两侧后再次校验。
  let realSession: string
  let realResolved: string
  try {
    realSession = realpathSync(sessionDir)
    realResolved = realpathSync(resolved)
  } catch {
    return null // 会话目录或附件不存在 / 链接断裂
  }
  if (!isWithinParent(realSession, realResolved)) return null

  let st: ReturnType<typeof statSync>
  try {
    st = statSync(resolved)
  } catch {
    return null
  }
  if (!st.isFile()) return null
  return resolved
}

/** 删除单个附件 */
export function deleteAttachment(localPath: string): void {
  const filePath = resolveAttachmentPath(localPath)
  if (existsSync(filePath)) {
    unlinkSync(filePath)
  }
}

/** 删除会话所有附件 */
export function deleteSessionAttachments(sessionId: string): void {
  const dir = join(getAttachmentsDir(), sessionId)
  if (existsSync(dir)) {
    rmSyncRobust(dir, { recursive: true, force: true })
  }
}
