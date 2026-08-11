/**
 * 把已落盘附件注入给运行核可见的用户内容。
 *
 * 根因：Chat 只把 attachments 写进面板 JSONL（UI 可见），enqueue / agent.prompt 仍是纯文本。
 *
 * 策略：
 * 1) 文本类（长粘贴转 .md、txt、json…）→ **内联正文**（附件在 ~/.tagent/attachments，常在 cwd 外，Read 读不到）
 * 2) 图片 → Anthropic image content block（kscc）+ 文案提示
 * 3) 其它二进制 → 附绝对路径（若工具允许跨目录再读）
 */
import {
  getAttachmentAbsolutePath,
  readAttachmentAsBase64,
  type FileAttachment,
} from '../attachment-service'

export type AttachmentRef = Pick<FileAttachment, 'filename' | 'mediaType' | 'localPath'>

/** Anthropic / Claude Agent SDK 用户 content 块（窄子集） */
export type UserContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      source: { type: 'base64'; media_type: string; data: string }
    }

/** 文本类附件：内联，不依赖 Read 路径 */
function isTextualAttachment(mediaType: string, filename: string): boolean {
  const mt = (mediaType || '').toLowerCase()
  if (mt.startsWith('text/')) return true
  if (
    mt === 'application/json' ||
    mt === 'application/xml' ||
    mt === 'application/javascript' ||
    mt === 'application/typescript' ||
    mt === 'application/x-yaml' ||
    mt === 'application/yaml' ||
    mt === 'application/sql'
  ) {
    return true
  }
  // 长粘贴 / 无准确 mime 时看扩展名
  const lower = filename.toLowerCase()
  return /\.(md|markdown|txt|json|jsonl|ya?ml|xml|csv|tsv|js|ts|tsx|jsx|py|rs|go|java|c|cpp|h|css|html|sql|log|sh|ps1|toml|ini|env)$/.test(
    lower,
  )
}

function decodeAttachmentText(localPath: string): string {
  const b64 = readAttachmentAsBase64(localPath)
  return Buffer.from(b64, 'base64').toString('utf8')
}

/**
 * 在用户文案后注入附件内容（文本内联 / 非文本给路径）。
 */
export function appendAttachmentPathsToPrompt(
  prompt: string,
  attachments?: AttachmentRef[] | null,
): string {
  if (!attachments?.length) return prompt

  const sections: string[] = ['[用户附件]']
  for (const att of attachments) {
    if (att.mediaType.startsWith('image/')) {
      try {
        const abs = getAttachmentAbsolutePath(att.localPath)
        sections.push(`- 图片 ${att.filename}（${att.mediaType}）：见下方 image 块；本地路径 ${abs}`)
      } catch {
        sections.push(`- 图片 ${att.filename}（${att.mediaType}）：见下方 image 块`)
      }
      continue
    }

    if (isTextualAttachment(att.mediaType, att.filename)) {
      try {
        const body = decodeAttachmentText(att.localPath)
        sections.push(
          `### 附件：${att.filename}（${att.mediaType}，全文如下）`,
          '```',
          body,
          '```',
        )
      } catch (err) {
        console.warn('[attachments] 内联文本附件失败:', att.filename, err)
        try {
          const abs = getAttachmentAbsolutePath(att.localPath)
          sections.push(`- ${att.filename}：内联失败，路径 ${abs}`)
        } catch {
          sections.push(`- ${att.filename}：无法读取`)
        }
      }
      continue
    }

    try {
      const abs = getAttachmentAbsolutePath(att.localPath)
      sections.push(`- ${att.filename} (${att.mediaType}): ${abs}`)
    } catch (err) {
      console.warn('[attachments] 解析附件路径失败:', att.filename, err)
      sections.push(`- ${att.filename} (${att.mediaType}): ${att.localPath}（路径无效）`)
    }
  }

  sections.push('以上附件正文已在消息中提供时请直接使用；图片请根据 image 块描述并回答。')
  const block = sections.join('\n')
  return prompt.trim() ? `${prompt.trim()}\n\n${block}` : block
}

/**
 * 构造发给 kscc SDK 的 user.message.content：
 * - 有图片 → content 数组（image blocks + text）
 * - 仅非图 / 无附件 → string（含内联/路径附录）
 */
export function buildSdkUserContent(
  prompt: string,
  attachments?: AttachmentRef[] | null,
): string | UserContentBlock[] {
  const text = appendAttachmentPathsToPrompt(prompt, attachments)
  return attachImageBlocksToText(text, attachments)
}

/**
 * 文本已含附件附录时使用：只补 image blocks，避免双重附录。
 */
export function attachImageBlocksToText(
  text: string,
  attachments?: AttachmentRef[] | null,
): string | UserContentBlock[] {
  const images = (attachments ?? []).filter((a) => a.mediaType.startsWith('image/'))
  if (images.length === 0) return text

  const blocks: UserContentBlock[] = []
  for (const img of images) {
    try {
      const data = readAttachmentAsBase64(img.localPath)
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.mediaType || 'image/png',
          data,
        },
      })
    } catch (err) {
      console.warn('[attachments] 读取图片失败，仅保留文案提示:', img.filename, err)
    }
  }
  blocks.push({ type: 'text', text })
  return blocks
}

/** 从 content 抽出纯文本（崩溃恢复 / lastInFlightPrompt 用） */
export function extractTextFromUserContent(content: string | UserContentBlock[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
}
