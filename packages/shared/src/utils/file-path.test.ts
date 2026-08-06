import { describe, expect, test } from 'vitest'

import {
  getFileName,
  isAbsoluteFilePath,
  isRelativeFilePath,
  msysPathToWindowsDrivePath,
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
})
