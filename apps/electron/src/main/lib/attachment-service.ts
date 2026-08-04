/**
 * 附件服务 — 文件持久化到磁盘
 *
 * 存储路径：~/.tagent[-dev]/attachments/{sessionId}/{uuid}.{ext}
 * 参考 Proma attachment-service.ts，适配 TAgent 数据目录。
 */
import { join, extname } from 'node:path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
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
