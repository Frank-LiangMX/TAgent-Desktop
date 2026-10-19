import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readJsonSafe, writeJsonAtomic } from '../atomic-json'
import { record, string, WpsApiError } from './wps-client'

export const WPS_DOCUMENT_CREATE_SCOPE = 'kso.mcp_airpage.readwrite'
export interface WpsDocumentInput { title: string; markdown: string }
export interface WpsCreatedDocument {
  created: true
  title: string
  fileId?: string
  url?: string
  location: 'MCP/智能文档'
  reused?: boolean
  warning?: string
}
interface Receipt { status: 'pending' | 'created'; result?: WpsCreatedDocument }

export function validateWpsDocument(input: WpsDocumentInput): void {
  if (!input || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200 || /[\x00-\x1f]/.test(input.title)) throw new Error('云文档标题应为 1–200 字，不能含控制字符。')
  if (typeof input.markdown !== 'string' || !input.markdown.trim() || input.markdown.length > 200_000) throw new Error('云文档正文应为非空 Markdown，最多 20 万字符；超限请拆分报告。')
}

function safeUrl(value: unknown): string | undefined {
  try {
    const url = new URL(string(value))
    if (url.protocol === 'https:' && !url.username && !url.password &&
      ['wps.cn', 'kdocs.cn', 'wps365.cn', 'wps365.com'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return url.href
  } catch { /* Platform responses may omit a link. */ }
  return undefined
}

/** Only return file locators, never an arbitrary remote payload. */
export function createdWpsDocument(data: unknown, title: string): WpsCreatedDocument {
  let fileId: string | undefined, url: string | undefined
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 5) return
    if (typeof value === 'string') {
      const link = value.trim().match(/^(?:已创建[：:]?\s*)?\[[^\]\n]+\]\((https:\/\/[^\s)]+)\)$/)?.[1]
        ?? value.match(/(?:文档链接|文档地址|文件链接|file_url|fileUrl)\s*[:：]\s*(https:\/\/[^\s<>"'\])}]+)/)?.[1]
      url ??= safeUrl(link ?? value.trim())
      return
    }
    if (Array.isArray(value)) { value.slice(0, 20).forEach(item => visit(item, depth + 1)); return }
    const item = record(value)
    fileId ??= string(item.file_id ?? item.fileId) || undefined
    for (const key of ['file_url', 'fileUrl', 'web_url', 'webUrl', 'url', 'link']) url ??= safeUrl(item[key])
    for (const key of ['data', 'file', 'result', 'document', 'content', 'text', 'message']) if (item[key] !== undefined) visit(item[key], depth + 1)
  }
  visit(data)
  if (!fileId && !url) throw new Error('WPS 未返回可确认的文件 ID 或文档链接。创建结果不明，请在 WPS「MCP/智能文档」文件夹按标题核对，不要重复创建。')
  return { created: true, title, ...(fileId ? { fileId } : {}), ...(url ? { url } : {}), location: 'MCP/智能文档',
    ...(!url ? { warning: 'WPS 已返回文件 ID，但未返回文档链接；请在 WPS「MCP/智能文档」文件夹按标题查找。' } : {}) }
}

/** Record intent before writing. An interrupted/ambiguous request is never blindly repeated. */
export async function createWpsDocumentOnce(
  configDir: string, account: { id: string; companyId?: string }, input: WpsDocumentInput,
  create: () => Promise<unknown>,
): Promise<WpsCreatedDocument> {
  validateWpsDocument(input)
  const key = createHash('sha256').update(JSON.stringify([account.id, account.companyId ?? '', input.title.trim(), input.markdown])).digest('hex')
  const path = join(configDir, 'wps-document-creations.json')
  const receipts = readJsonSafe<Record<string, Receipt>>(path, {})
  const previous = receipts[key]
  if (previous?.status === 'created' && previous.result) return { ...previous.result, reused: true }
  if (previous) throw new Error('相同报告已有创建请求，结果尚未确认。请在 WPS「MCP/智能文档」按标题核对，不要重复创建。')
  writeJsonAtomic(path, { ...receipts, [key]: { status: 'pending' } })
  let result: WpsCreatedDocument
  try { result = createdWpsDocument(await create(), input.title.trim()) }
  catch (error) {
    if (error instanceof WpsApiError && (error.status === 401 || error.status === 403)) {
      // A definite permission rejection did not create anything; allow a later authorized attempt.
      const latest = readJsonSafe<Record<string, Receipt>>(path, {})
      delete latest[key]
      writeJsonAtomic(path, latest)
      throw new Error('WPS 拒绝创建云文档。请确认应用已开通 kso.mcp_airpage.readwrite 用户授权权限，并在设置中重新「授权创建云文档」。')
    }
    throw new Error('WPS 云文档创建结果未确认，可能是权限不足、连接失败或响应不完整。请先在 WPS「MCP/智能文档」按标题核对；不要自动重试创建。')
  }
  const latest = readJsonSafe<Record<string, Receipt>>(path, {})
  writeJsonAtomic(path, { ...latest, [key]: { status: 'created', result } })
  return result
}
