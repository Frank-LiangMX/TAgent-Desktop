import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createSerialJsonWriter, readJsonSafe, writeJsonAtomic } from './atomic-json'

let dir: string
let counter = 0

function freshDir(): string {
  dir = mkdtempSync(join(tmpdir(), `tagent-atomic-${counter++}-`))
  return dir
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('writeJsonAtomic', () => {
  it('正常写入可读回', () => {
    const file = join(freshDir(), 'a.json')
    writeJsonAtomic(file, { a: 1, list: [1, 2] })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ a: 1, list: [1, 2] })
  })

  it('写入后生成 .bak 备份', () => {
    const file = join(freshDir(), 'b.json')
    writeJsonAtomic(file, { v: 1 })
    writeJsonAtomic(file, { v: 2 })
    expect(existsSync(`${file}.bak`)).toBe(true)
    expect(JSON.parse(readFileSync(`${file}.bak`, 'utf8'))).toEqual({ v: 1 })
  })

  it('不残留临时文件', () => {
    const file = join(freshDir(), 'c.json')
    writeJsonAtomic(file, { v: 1 })
    const leftovers = readdirSync(dir).filter((name) => name.includes('.tmp-'))
    expect(leftovers).toEqual([])
  })
})

describe('readJsonSafe', () => {
  it('主文件损坏时从 .bak 恢复', () => {
    const file = join(freshDir(), 'd.json')
    writeJsonAtomic(file, { v: 'old' })
    writeJsonAtomic(file, { v: 'good' }) // 第二次写产生 .bak（内容是 old，但恢复路径取 .bak）
    // 模拟损坏：写半截 JSON（不经过原子写）
    writeFileSync(file, '{"v": "broken', 'utf8')
    const result = readJsonSafe<{ v: string } | null>(file, null)
    expect(result).toEqual({ v: 'old' })
    // 恢复后主文件已修复
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ v: 'old' })
  })

  it('无备份损坏时返回 fallback 并保留 .corrupt', () => {
    const file = join(freshDir(), 'e.json')
    writeFileSync(file, 'not json at all', 'utf8')
    const result = readJsonSafe<number[]>(file, [])
    expect(result).toEqual([])
    expect(existsSync(`${file}.corrupt`)).toBe(true)
  })

  it('文件不存在返回 fallback', () => {
    const file = join(freshDir(), 'missing.json')
    expect(readJsonSafe(file, 'default')).toBe('default')
  })

  it('正常文件直接读', () => {
    const file = join(freshDir(), 'f.json')
    writeFileSync(file, '{"ok":true}', 'utf8')
    expect(readJsonSafe<{ ok: boolean } | null>(file, null)).toEqual({ ok: true })
  })
})

describe('createSerialJsonWriter', () => {
  it('并发写入按序完成，最终值正确', async () => {
    const file = join(freshDir(), 'g.json')
    const writer = createSerialJsonWriter(file)
    await Promise.all([
      writer({ n: 1 }),
      writer({ n: 2 }),
      writer({ n: 3 }),
    ])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ n: 3 })
  })
})
