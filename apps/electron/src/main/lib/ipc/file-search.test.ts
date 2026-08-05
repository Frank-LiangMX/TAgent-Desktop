import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { findFileByName } from './file-search'

let root: string

function write(relative: string, content = ''): string {
  const full = join(root, relative)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
  return full
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tagent-file-search-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('findFileByName', () => {
  test('能找到构建产物目录里的文件（main.cjs 这类打包输出）', () => {
    const expected = write('apps/electron/dist/main.cjs', '// bundle')

    expect(findFileByName(root, 'main.cjs')).toBe(expected)
  })

  test('源文件优先于同名产物文件', () => {
    const source = write('packages/core/src/index.js', 'source')
    write('packages/core/dist/index.js', 'bundled')

    expect(findFileByName(root, 'index.js')).toBe(source)
  })

  test('依赖与版本控制目录始终不扫', () => {
    write('node_modules/some-pkg/only-here.ts')
    write('.git/objects/only-here-too.ts')

    expect(findFileByName(root, 'only-here.ts')).toBeNull()
    expect(findFileByName(root, 'only-here-too.ts')).toBeNull()
  })

  test('文件名比对不区分大小写', () => {
    const expected = write('src/Chat.tsx')

    expect(findFileByName(root, 'chat.tsx')).toBe(expected)
  })

  test('同层文件优先于更深目录里的同名文件', () => {
    const shallow = write('README.md')
    write('docs/nested/deeper/README.md')

    expect(findFileByName(root, 'README.md')).toBe(shallow)
  })

  test('找不到时返回 null', () => {
    write('src/index.ts')

    expect(findFileByName(root, 'nope.ts')).toBeNull()
  })
})
