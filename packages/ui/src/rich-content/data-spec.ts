/**
 * 数据块 JSON spec 归一化（自研）
 *
 * datatable / spreadsheet 围栏内是 JSON spec：
 * {
 *   "title"?: string,
 *   "filename"?: string,
 *   "sheetName"?: string,
 *   "columns"?: Array<string | { key; label?; type? }>,
 *   "rows"?: Array<DataValue[] | Record<string, DataValue>>,
 *   "src"?: string,        // 外部数据源（预览类块用）
 *   "groupBy"?: string
 * }
 *
 * 归一化后统一为 columns + columnDefs + rows 三元组，坏 spec 返回 null。
 */

export type DataValue = string | number | boolean | null

export interface ColumnDef {
  key: string
  label?: string
  type?: string
}

export interface DataSpec {
  title?: string
  filename?: string
  sheetName?: string
  columns?: Array<string | ColumnDef>
  rows?: Array<DataValue[] | Record<string, DataValue>>
  src?: string
  groupBy?: string
}

export interface NormalizedDataSpec {
  columns: string[]
  columnDefs: ColumnDef[]
  rows: DataValue[][]
}

export function parseDataSpec(code: string): DataSpec | null {
  if (!code || typeof code !== 'string') return null
  try {
    const value = JSON.parse(code.trim()) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return value as DataSpec
  } catch {
    return null
  }
}

export function normalizeDataSpec(spec: DataSpec | null): NormalizedDataSpec | null {
  if (!spec) return null

  const rawColumns = Array.isArray(spec.columns) ? spec.columns : []
  const columnDefs: ColumnDef[] = rawColumns.map((column, index) =>
    typeof column === 'string'
      ? { key: `c${index}`, label: column, type: 'text' }
      : {
          key: column?.key ?? `c${index}`,
          label: column?.label ?? column?.key ?? `c${index}`,
          type: column?.type ?? 'text',
        },
  )

  const rawRows = Array.isArray(spec.rows) ? spec.rows : []
  const rows: DataValue[][] = rawRows.map((row) => {
    if (Array.isArray(row)) return row.map((value) => normalizeValue(value))
    if (row && typeof row === 'object') {
      return columnDefs.map((column) => normalizeValue((row as Record<string, unknown>)[column.key] ?? null))
    }
    return []
  })

  if (rows.length > 0 && columnDefs.length === 0) {
    // 只有数组行没有列定义：按行长度推断列名
    const width = Math.max(...rows.map((row) => row.length))
    for (let i = 0; i < width; i++) columnDefs.push({ key: `c${i}`, label: `列 ${i + 1}`, type: 'text' })
  }

  return { columns: columnDefs.map((c) => c.label ?? c.key), columnDefs, rows }
}

function normalizeValue(value: unknown): DataValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** 生成 CSV（带 BOM，Excel 打开中文不乱码） */
export function toCsv(spec: NormalizedDataSpec): string {
  const escape = (value: DataValue): string => {
    const text = value == null ? '' : String(value)
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const header = spec.columns.map(escape).join(',')
  const body = spec.rows.map((row) => row.map(escape).join(',')).join('\n')
  return `\uFEFF${header}${body ? `\n${body}` : ''}`
}
