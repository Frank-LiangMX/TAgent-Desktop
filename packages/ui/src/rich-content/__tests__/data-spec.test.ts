import { describe, expect, it } from 'vitest'

import { normalizeDataSpec, parseDataSpec, toCsv, type DataValue } from '../data-spec'

describe('parseDataSpec', () => {
  it('解析合法 spec', () => {
    const spec = parseDataSpec('{"title":"t","rows":[["a"]]}')
    expect(spec?.title).toBe('t')
    expect(spec?.rows).toEqual([['a']])
  })

  it('坏 JSON 返回 null', () => {
    expect(parseDataSpec('not json')).toBeNull()
    expect(parseDataSpec('')).toBeNull()
    expect(parseDataSpec('[1,2]')).toBeNull()
  })
})

describe('normalizeDataSpec', () => {
  it('字符串列 + 数组行', () => {
    const normalized = normalizeDataSpec({
      columns: ['名称', '大小'],
      rows: [['a.png', 2048]],
    })
    expect(normalized).not.toBeNull()
    expect(normalized!.columns).toEqual(['名称', '大小'])
    expect(normalized!.rows).toEqual([['a.png', 2048]])
  })

  it('对象列定义保留 label/type', () => {
    const normalized = normalizeDataSpec({
      columns: [{ key: 'name', label: '名称', type: 'text' }, { key: 'size', type: 'number' }],
      rows: [{ name: 'a', size: 100 }],
    })
    expect(normalized!.columns).toEqual(['名称', 'size'])
    expect(normalized!.columnDefs[1]!.type).toBe('number')
    expect(normalized!.rows).toEqual([['a', 100]])
  })

  it('只有数组行无列定义时推断列', () => {
    const normalized = normalizeDataSpec({ rows: [[1, 2, 3], [4, 5, 6]] })
    expect(normalized!.columns).toEqual(['列 1', '列 2', '列 3'])
  })

  it('null spec 返回 null', () => {
    expect(normalizeDataSpec(null)).toBeNull()
  })

  it('对象值转字符串', () => {
    const normalized = normalizeDataSpec({
      columns: [{ key: 'v', label: 'v' }],
      rows: [{ v: { a: 1 } as unknown as DataValue }],
    })
    expect(normalized!.rows[0]![0]).toBe('{"a":1}')
  })
})

describe('toCsv', () => {
  it('生成带 BOM 的 CSV', () => {
    const normalized = normalizeDataSpec({ columns: ['名称', '值'], rows: [['a,b', 1]] })!
    const csv = toCsv(normalized)
    expect(csv.startsWith('\uFEFF')).toBe(true)
    expect(csv).toContain('"a,b"')
    expect(csv).toContain('名称,值')
  })

  it('空表生成表头', () => {
    const normalized = normalizeDataSpec({ columns: ['x'] })!
    expect(toCsv(normalized)).toBe('\uFEFFx')
  })
})
