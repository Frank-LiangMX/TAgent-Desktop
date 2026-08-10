import { describe, expect, test } from 'vitest'

import {
  cleanFilePathInput,
  existsCacheKey,
  getFileName,
  isAbsoluteFilePath,
  isRelativeFilePath,
  joinBasePath,
  msysPathToWindowsDrivePath,
  normalizeFilePathSeparators,
  stripLineCol,
} from './file-path'

describe('isAbsoluteFilePath', () => {
  test('POSIX 绝对路径', () => {
    expect(isAbsoluteFilePath('/home/user/project/a.ts')).toBe(true)
  })

  test('Windows 盘符 + 反斜杠（大写）', () => {
    expect(isAbsoluteFilePath('F:\\TAgent_General\\a.ts')).toBe(true)
  })

  test('Windows 盘符 + 反斜杠（小写）', () => {
    expect(isAbsoluteFilePath('f:\\TAgent_General\\a.ts')).toBe(true)
  })

  test('Windows 盘符 + 正斜杠', () => {
    expect(isAbsoluteFilePath('F:/TAgent_General/a.ts')).toBe(true)
    expect(isAbsoluteFilePath('f:/TAgent_General/a.ts')).toBe(true)
  })

  test('UNC 路径', () => {
    expect(isAbsoluteFilePath('\\\\server\\share\\file.ts')).toBe(true)
  })

  test('相对路径返回 false', () => {
    expect(isAbsoluteFilePath('src/a.ts')).toBe(false)
    expect(isAbsoluteFilePath('./src/a.ts')).toBe(false)
  })

  test('带行号后缀的绝对路径', () => {
    expect(isAbsoluteFilePath('F:/proj/a.ts:42')).toBe(true)
    expect(isAbsoluteFilePath('/home/u/a.ts:10:5')).toBe(true)
  })

  test('API / URL 风格路径不升 FileChip（Anthropic /v1/messages）', () => {
    expect(isAbsoluteFilePath('/v1/messages')).toBe(false)
    expect(isAbsoluteFilePath('/v1/chat/completions')).toBe(false)
    expect(isAbsoluteFilePath('/api/foo')).toBe(false)
    expect(isAbsoluteFilePath('/graphql')).toBe(false)
    expect(isAbsoluteFilePath('/health')).toBe(false)
  })

  test('无扩展名的随意 /foo/bar 不升 FileChip', () => {
    expect(isAbsoluteFilePath('/foo/bar')).toBe(false)
    expect(isAbsoluteFilePath('/Anthropic/v1/messages')).toBe(false)
  })

  test('MSYS 盘符挂载与常见 FS 根仍识别', () => {
    expect(isAbsoluteFilePath('/f/TAgent-Desktop/a.ts')).toBe(true)
    expect(isAbsoluteFilePath('/home/user/bin/tool')).toBe(true)
    expect(isAbsoluteFilePath('/tmp/out.log')).toBe(true)
  })

  test('省略号截断路径不升 FileChip（D:/proj/...）', () => {
    expect(isAbsoluteFilePath('D:/sword3-products/...')).toBe(false)
    expect(isAbsoluteFilePath('D:\\sword3-products\\...')).toBe(false)
    expect(isAbsoluteFilePath('D:/sword3-products/.../a.ts')).toBe(false)
    expect(isAbsoluteFilePath('/home/user/…/a.ts')).toBe(false)
  })
})

describe('getFileName', () => {
  test('POSIX 路径', () => {
    expect(getFileName('/a/b/c.ts')).toBe('c.ts')
  })

  test('Windows 反斜杠路径', () => {
    expect(getFileName('F:\\a\\b\\c.ts')).toBe('c.ts')
  })

  test('混用分隔符', () => {
    expect(getFileName('F:/a\\b/c.ts')).toBe('c.ts')
  })
})

describe('stripLineCol', () => {
  test('剥离行号列号', () => {
    expect(stripLineCol('a.ts:12:3')).toEqual({ path: 'a.ts', suffix: ':12:3' })
    expect(stripLineCol('F:/proj/a.ts:42')).toEqual({ path: 'F:/proj/a.ts', suffix: ':42' })
  })

  test('不误伤 Windows 盘符', () => {
    expect(stripLineCol('F:\\proj\\a.ts')).toEqual({ path: 'F:\\proj\\a.ts', suffix: '' })
  })
})

describe('cleanFilePathInput', () => {
  test('去引号与空白', () => {
    expect(cleanFilePathInput('  "./src/a.ts"  ')).toBe('./src/a.ts')
    expect(cleanFilePathInput("'src/a.ts'")).toBe('src/a.ts')
  })

  test('剥行号后缀', () => {
    expect(cleanFilePathInput('src/a.ts:42')).toBe('src/a.ts')
    expect(cleanFilePathInput('src/a.ts:42:7')).toBe('src/a.ts')
  })

  test('file:// URL', () => {
    expect(cleanFilePathInput('file:///C:/proj/a.ts')).toBe('C:/proj/a.ts')
  })
})

describe('msysPathToWindowsDrivePath', () => {
  test('MSYS 盘符挂载路径转换为 Windows 盘符路径', () => {
    expect(msysPathToWindowsDrivePath('/f/TAgent-Desktop/a.ts')).toBe('F:\\TAgent-Desktop\\a.ts')
    expect(msysPathToWindowsDrivePath('/c/Users/x/a.ts')).toBe('C:\\Users\\x\\a.ts')
    expect(msysPathToWindowsDrivePath('/f/foo.txt')).toBe('F:\\foo.txt')
  })

  test('非 MSYS 形态返回 null', () => {
    expect(msysPathToWindowsDrivePath('F:\\TAgent-Desktop\\a.ts')).toBeNull()
    expect(msysPathToWindowsDrivePath('F:/TAgent-Desktop/a.ts')).toBeNull()
    expect(msysPathToWindowsDrivePath('/home/user/a.ts')).toBeNull() // 多字母段不是盘符挂载
    expect(msysPathToWindowsDrivePath('src/a.ts')).toBeNull()
    expect(msysPathToWindowsDrivePath('/f')).toBeNull()
    expect(msysPathToWindowsDrivePath('/f/')).toBeNull()
  })
})

describe('isRelativeFilePath', () => {
  test('Windows 反斜杠相对路径识别（Agent 输出 py\\parse_mesh.py）', () => {
    expect(isRelativeFilePath('py\\parse_mesh.py')).toBe(true)
    expect(isRelativeFilePath('docs\\memory\\a.md')).toBe(true)
    expect(isRelativeFilePath('src\\a.ts:42')).toBe(true)
    expect(isRelativeFilePath('py\\parse_mesh')).toBe(false) // 无扩展名
  })

  test('正斜杠相对路径仍识别', () => {
    expect(isRelativeFilePath('py/parse_mesh.py')).toBe(true)
    expect(isRelativeFilePath('src/a.ts:42')).toBe(true)
  })

  test('省略号截断相对路径不升 FileChip', () => {
    expect(isRelativeFilePath('src/.../a.ts')).toBe(false)
    expect(isRelativeFilePath('…/config.js')).toBe(false)
  })
})

describe('normalizeFilePathSeparators (REGRESS-J J6)', () => {
  test('反斜杠归一为正斜杠', () => {
    expect(normalizeFilePathSeparators('D:\\UnrealTagManager\\Foo\\Bar.h')).toBe(
      'D:/UnrealTagManager/Foo/Bar.h',
    )
    expect(normalizeFilePathSeparators('src\\a.ts')).toBe('src/a.ts')
  })

  test('正斜杠保持原样', () => {
    expect(normalizeFilePathSeparators('src/a.ts')).toBe('src/a.ts')
  })
})

describe('joinBasePath (REGRESS-J J6)', () => {
  test('base 反斜杠 + 相对正斜杠 → 统一 `/` 的绝对路径（D:\\UnrealTagManager + Foo/Bar.h）', () => {
    expect(joinBasePath('D:\\UnrealTagManager', 'Foo/Bar.h')).toBe('D:/UnrealTagManager/Foo/Bar.h')
    expect(joinBasePath('D:\\UnrealTagManager\\', '/Foo/Bar.h')).toBe(
      'D:/UnrealTagManager/Foo/Bar.h',
    )
    expect(joinBasePath('C:/proj', 'a\\b.ts')).toBe('C:/proj/a/b.ts')
  })

  test('空相对路径退回 base', () => {
    expect(joinBasePath('D:/proj', '')).toBe('D:/proj')
  })
})

describe('existsCacheKey (REGRESS-J J6)', () => {
  test('同一文件不同分隔符写法命中同一缓存键', () => {
    expect(existsCacheKey('Foo/Bar.h', ['D:\\UnrealTagManager'])).toBe(
      existsCacheKey('Foo\\Bar.h', ['D:/UnrealTagManager']),
    )
    expect(existsCacheKey('Foo/Bar.h', ['D:\\UnrealTagManager'])).toBe(
      'Foo/Bar.h\0D:/UnrealTagManager',
    )
  })
})
