import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWpsDocumentOnce, createdWpsDocument, validateWpsDocument } from './wps-document-create'
import { WpsApiError } from './wps-client'

let root: string
const input = { title: '工作周报', markdown: '# 本周进展\n\n- 完成接口联调\n\n[来源](https://365.kdocs.cn/l/source)' }
const account = { id: 'me', companyId: 'company' }
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'tagent-wps-create-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('WPS report cloud document creation', () => {
  it('persists only locators and deduplicates the same report across calls and restarts', async () => {
    const create = vi.fn().mockResolvedValue({ file_id: 'file-1', file_url: 'https://365.kdocs.cn/l/report' })
    expect(await createWpsDocumentOnce(root, account, input, create)).toMatchObject({ created: true, fileId: 'file-1', url: 'https://365.kdocs.cn/l/report' })
    expect(await createWpsDocumentOnce(root, account, input, create)).toMatchObject({ reused: true })
    expect(create).toHaveBeenCalledTimes(1)
    const receipts = readFileSync(join(root, 'wps-document-creations.json'), 'utf8')
    expect(receipts).not.toContain(input.markdown)
    await createWpsDocumentOnce(root, { id: 'other' }, input, create)
    expect(create).toHaveBeenCalledTimes(2)
  })
  it('prevents concurrent creation and keeps ambiguous requests pending', async () => {
    let resolve!: (value: unknown) => void
    const create = vi.fn(() => new Promise(done => { resolve = done }))
    const first = createWpsDocumentOnce(root, account, input, create)
    await expect(createWpsDocumentOnce(root, account, input, create)).rejects.toThrow('尚未确认')
    resolve({ file_id: 'file' })
    expect(await first).toMatchObject({ fileId: 'file', warning: expect.stringContaining('未返回文档链接') })
    expect(create).toHaveBeenCalledTimes(1)
    const fail = vi.fn().mockRejectedValue(new Error('timeout contains secret-request'))
    await expect(createWpsDocumentOnce(root, account, { ...input, title: '另一份报告' }, fail)).rejects.toThrow('创建结果未确认')
    await expect(createWpsDocumentOnce(root, account, { ...input, title: '另一份报告' }, fail)).rejects.toThrow('尚未确认')
    expect(fail).toHaveBeenCalledTimes(1)
    expect(readFileSync(join(root, 'wps-document-creations.json'), 'utf8')).not.toContain('secret-request')
  })
  it('allows a retry after a definite permission refusal', async () => {
    const create = vi.fn().mockRejectedValueOnce(new WpsApiError(403)).mockResolvedValue({ file_id: 'file' })
    await expect(createWpsDocumentOnce(root, account, input, create)).rejects.toThrow('WPS 拒绝')
    expect(await createWpsDocumentOnce(root, account, input, create)).toMatchObject({ created: true })
  })
  it('does not claim success on an unidentifiable response or invent a link', async () => {
    expect(createdWpsDocument('已创建：[报告](https://365.kdocs.cn/l/report)', input.title)).toMatchObject({ url: 'https://365.kdocs.cn/l/report' })
    expect(() => createdWpsDocument({ message: 'success' }, input.title)).toThrow('创建结果不明')
    expect(() => createdWpsDocument(input.markdown, input.title)).toThrow('创建结果不明')
    expect(() => createdWpsDocument({ url: 'https://wps.cn.attacker.example/report' }, input.title)).toThrow()
    expect(createdWpsDocument({ file_id: 'file', url: 'javascript:alert(1)' }, input.title).url).toBeUndefined()
  })
  it('rejects empty or oversized inputs before a remote write', () => {
    for (const invalid of [{ ...input, title: ' ' }, { ...input, title: 'a\nb' }, { ...input, title: 'a'.repeat(201) },
      { ...input, markdown: ' ' }, { ...input, markdown: 'a'.repeat(200_001) }]) expect(() => validateWpsDocument(invalid)).toThrow()
  })
})
