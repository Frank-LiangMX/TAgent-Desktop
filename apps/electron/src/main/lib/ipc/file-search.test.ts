import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  clearFileSearchCache,
  findFileByName,
  findFileByNameCached,
  FILE_SEARCH_MAX_DEPTH,
} from './file-search'

let root: string

function write(relative: string, content = ''): string {
  const full = join(root, relative)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
  return full
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tagent-file-search-'))
  clearFileSearchCache()
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

  test('能命中本仓库规模的深层源文件（monorepo 典型深度）', () => {
    // apps/electron/src/main/lib/ipc/deep-target.ts —— 与真实仓库最深源码同量级
    const expected = write('apps/electron/src/main/lib/ipc/adapters/deep-target.ts')

    expect(findFileByName(root, 'deep-target.ts')).toBe(expected)
  })

  test('超过深度上限的文件不扫（守住主线程耗时）', () => {
    const overDepth = Array.from({ length: FILE_SEARCH_MAX_DEPTH + 1 }, (_, i) => `d${i}`).join('/')
    write(`${overDepth}/too-deep.ts`)

    expect(findFileByName(root, 'too-deep.ts')).toBeNull()
  })
})

describe('findFileByNameCached', () => {
  test('未命中不写缓存：文件随后被创建能立刻查到', () => {
    expect(findFileByNameCached(root, 'created-later.ts')).toBeNull()

    const created = write('src/created-later.ts')

    expect(findFileByNameCached(root, 'created-later.ts')).toBe(created)
  })

  test('命中写缓存：后续同名请求直接复用旧结果，不重扫', () => {
    const first = write('deep/nested/cached.ts')
    expect(findFileByNameCached(root, 'cached.ts')).toBe(first)

    // 更浅的同名文件在重扫时一定会赢；仍返回旧路径即证明走的是缓存
    write('cached.ts')

    expect(findFileByNameCached(root, 'cached.ts')).toBe(first)
  })

  test('缓存的命中路径消失后重扫，不返回失效路径', () => {
    const first = write('deep/nested/moved.ts')
    expect(findFileByNameCached(root, 'moved.ts')).toBe(first)

    unlinkSync(first)
    const moved = write('src/moved.ts')

    expect(findFileByNameCached(root, 'moved.ts')).toBe(moved)
  })

  test('缓存按根目录隔离', () => {
    const other = mkdtempSync(join(tmpdir(), 'tagent-file-search-other-'))
    try {
      const inRoot = write('src/shared-name.ts')

      expect(findFileByNameCached(root, 'shared-name.ts')).toBe(inRoot)
      expect(findFileByNameCached(other, 'shared-name.ts')).toBeNull()
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})
