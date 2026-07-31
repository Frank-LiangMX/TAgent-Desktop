/**
 * 剪贴板长文本 → 附件转换
 *
 * 超过阈值的粘贴文本自动转为 .md 文件附件，避免消息体过长撑爆 context。
 * 参考 Proma clipboard-text-attachment.ts。
 */

/** 文本转附件阈值（字符数） */
const TEXT_TO_ATTACHMENT_THRESHOLD = 2000

/**
 * 判断剪贴板文本是否应转为附件
 * 条件：纯文本（无文件）+ 超过阈值
 */
export function shouldConvertTextToAttachment(
  clipboardData: DataTransfer,
): boolean {
  // 有文件 → 不转（走文件附件流程）
  if (Array.from(clipboardData.items).some((item) => item.kind === 'file')) {
    return false
  }
  const text = clipboardData.getData('text/plain')
  return text.length > TEXT_TO_ATTACHMENT_THRESHOLD
}

/**
 * 从剪贴板文本创建待发附件（.md 文件）
 * 返回 PendingAttachment 形状的对象
 */
export function createTextAttachment(text: string): {
  id: string
  filename: string
  mediaType: string
  size: number
  data: string // base64
} {
  const now = new Date()
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
  const filename = `clipboard-${ts}.md`
  const data = btoa(unescape(encodeURIComponent(text)))

  return {
    id: `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    filename,
    mediaType: 'text/markdown',
    size: text.length,
    data,
  }
}
