/**
 * build-user-content-with-attachments 单测
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => tmpdir() },
}))

describe('build-user-content-with-attachments', () => {
  let configDir: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'tagent-att-'))
    process.env.TAGENT_CONFIG_DIR = configDir
  })

  afterEach(() => {
    delete process.env.TAGENT_CONFIG_DIR
    rmSync(configDir, { recursive: true, force: true })
    vi.resetModules()
  })

  it('无附件 → prompt 原样', async () => {
    const { appendAttachmentPathsToPrompt } = await import('./build-user-content-with-attachments')
    expect(appendAttachmentPathsToPrompt('hello')).toBe('hello')
  })

  it('长文本 .md 附件 → 内联正文（不靠 cwd 外路径）', async () => {
    const { saveAttachment } = await import('../attachment-service')
    const { appendAttachmentPathsToPrompt } = await import('./build-user-content-with-attachments')
    const body = '这是一段超过阈值粘贴进来的长文本内容 ABC123'
    const saved = saveAttachment({
      sessionId: 's1',
      filename: 'clipboard-20260811.md',
      mediaType: 'text/markdown',
      data: Buffer.from(body, 'utf8').toString('base64'),
    })
    const out = appendAttachmentPathsToPrompt('请总结', [saved])
    expect(out).toContain('请总结')
    expect(out).toContain('clipboard-20260811.md')
    expect(out).toContain('ABC123')
    expect(out).toContain('全文如下')
  })

  it('图片 → attachImageBlocksToText 产出 image+text 块', async () => {
    const { saveAttachment } = await import('../attachment-service')
    const { appendAttachmentPathsToPrompt, attachImageBlocksToText } = await import(
      './build-user-content-with-attachments'
    )
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    const saved = saveAttachment({
      sessionId: 's1',
      filename: 'dot.png',
      mediaType: 'image/png',
      data: png.toString('base64'),
    })
    const text = appendAttachmentPathsToPrompt('图呢', [saved])
    const content = attachImageBlocksToText(text, [saved])
    expect(Array.isArray(content)).toBe(true)
    if (Array.isArray(content)) {
      expect(content[0]).toMatchObject({ type: 'image' })
      expect(content.at(-1)).toMatchObject({ type: 'text', text })
    }
  })

  it('二进制附件（.docx）→ 附 localPath + kb_read_attachment 提示（供 Agent 调用工具）', async () => {
    const { saveAttachment } = await import('../attachment-service')
    const { appendAttachmentPathsToPrompt } = await import('./build-user-content-with-attachments')
    const saved = saveAttachment({
      sessionId: 's1',
      filename: 'report.docx',
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      data: Buffer.from('placeholder').toString('base64'),
    })
    const out = appendAttachmentPathsToPrompt('请整理成知识库', [saved])
    expect(out).toContain('请整理成知识库')
    expect(out).toContain('report.docx')
    // 透出相对 localPath，供 Agent 喂给 kb_read_attachment
    expect(out).toContain('localPath=' + saved.localPath)
    expect(out).toContain('kb_read_attachment')
    // 仍保留绝对路径供回退
    expect(out).toContain('绝对路径')
    // 工作流提示：整理需先读取再经确认保存
    expect(out).toContain('kb_propose_save')
  })
})
