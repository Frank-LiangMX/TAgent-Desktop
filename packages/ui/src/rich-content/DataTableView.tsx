/**
 * DataTableView — datatable / spreadsheet 数据表格（自研）
 *
 * 围栏内是 JSON spec（见 data-spec.ts）。能力：
 * - 关键字搜索 + 按列过滤
 * - 列头点击排序（数值感知）
 * - 可选分组列（折叠/展开组）
 * - CSV 导出（内建）/ XLSX 导出（动态 import write-excel-file）
 * - 全屏查看
 */
import * as React from 'react'

import { cn } from '../lib/utils'
import {
  normalizeDataSpec,
  parseDataSpec,
  toCsv,
  type DataValue,
  type NormalizedDataSpec,
} from './data-spec'
import { RichFrame } from './RichFrame'

interface DataTableViewProps {
  code: string
  spreadsheet?: boolean
}

function formatValue(value: DataValue, type: string): string {
  if (value == null) return ''
  if (type === 'number' && typeof value === 'number') {
    return new Intl.NumberFormat().format(value)
  }
  if (type === 'percent' && typeof value === 'number') {
    return new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 }).format(value)
  }
  if (type === 'boolean') return value ? '是' : '否'
  return String(value)
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export function DataTableView({ code, spreadsheet = false }: DataTableViewProps): React.ReactElement | null {
  const normalized = React.useMemo<NormalizedDataSpec | null>(() => {
    const spec = parseDataSpec(code)
    return normalizeDataSpec(spec)
  }, [code])

  const [query, setQuery] = React.useState('')
  const [filters, setFilters] = React.useState<Record<number, string>>({})
  const [sort, setSort] = React.useState<{ index: number; direction: 1 | -1 } | null>(null)
  const [groupIndex, setGroupIndex] = React.useState(-1)
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => new Set())

  const hasGroupBy =
    normalized !== null && groupIndex >= 0 && groupIndex < normalized.columns.length

  // 搜索 + 过滤
  const filtered = React.useMemo(() => {
    if (!normalized) return []
    const term = query.trim().toLocaleLowerCase()
    return normalized.rows.filter((row) => {
      if (term && !row.some((value) => String(value ?? '').toLocaleLowerCase().includes(term))) return false
      return Object.entries(filters).every(
        ([index, value]) =>
          !value.trim() ||
          String(row[Number(index)] ?? '').toLocaleLowerCase().includes(value.trim().toLocaleLowerCase()),
      )
    })
  }, [normalized, query, filters])

  // 排序
  const visibleRows = React.useMemo(() => {
    if (!sort) return filtered
    return [...filtered].sort((a, b) => {
      const va = a[sort.index]
      const vb = b[sort.index]
      const diff =
        typeof va === 'number' && typeof vb === 'number'
          ? va - vb
          : String(va ?? '').localeCompare(String(vb ?? ''), undefined, { numeric: true })
      return diff * sort.direction
    })
  }, [filtered, sort])

  const groupData = React.useMemo(() => {
    if (!normalized || !hasGroupBy) return null
    const groups = new Map<string, DataValue[][]>()
    for (const row of visibleRows) {
      const key = String(row[groupIndex] ?? '—')
      groups.set(key, [...(groups.get(key) ?? []), row])
    }
    return [...groups.entries()]
  }, [normalized, hasGroupBy, groupIndex, visibleRows])

  // 围栏内容非法/未闭合（流式半截或模型输出坏 JSON）→ 提示而非空白。必须在所有 hooks 之后 return，
  // 否则 hook 顺序在「有数据 / 无数据」渲染间变化，React 报 Rendered more hooks。
  if (!normalized) {
    return (
      <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground">
        表格数据无效（JSON 解析失败，内容可能不完整）
      </div>
    )
  }

  const { columns, columnDefs, rows } = normalized

  const handleSort = (index: number): void => {
    setSort((current) =>
      current?.index === index
        ? { index, direction: current.direction === 1 ? -1 : 1 }
        : { index, direction: 1 },
    )
  }

  const exportCsv = (): void => {
    downloadBlob(new Blob([toCsv({ columns, columnDefs, rows: visibleRows })]), 'data.csv')
  }

  const exportXlsx = async (): Promise<void> => {
    const { default: writeXlsxFile } = await import('write-excel-file/browser')
    const sheet = [columns, ...visibleRows.map((row) => row.map((value) => (value == null ? '' : value)))]
    await writeXlsxFile(sheet).toFile('data.xlsx')
  }

  const renderRow = (row: DataValue[], rowKey: string): React.ReactElement => (
    <tr key={rowKey} className="border-t border-border/50 hover:bg-muted/20">
      {row.map((value, cellIndex) => (
        <td key={cellIndex} className="px-2.5 py-1 align-top text-foreground/85">
          <span className={cn('break-words', columnDefs[cellIndex]?.type === 'number' && 'tabular-nums')}>
            {formatValue(value, columnDefs[cellIndex]?.type ?? 'text')}
          </span>
        </td>
      ))}
    </tr>
  )

  const table = (
    <div className="data-table">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-2.5 py-1.5">
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索数据"
          className="h-7 min-w-0 flex-1 rounded-md border border-border/70 bg-background/40 px-2 text-xs text-foreground outline-none transition-colors focus:border-primary/50"
        />
        {!spreadsheet && columns.length > 0 && (
          <select
            value={groupIndex}
            onChange={(event) => setGroupIndex(Number(event.target.value))}
            className="h-7 rounded-md border border-border/70 bg-background/40 px-1.5 text-xs text-foreground outline-none"
          >
            <option value={-1}>不分组</option>
            {columns.map((column, index) => (
              <option key={column} value={index}>
                按 {column} 分组
              </option>
            ))}
          </select>
        )}
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{visibleRows.length} 行</span>
      </div>

      <div className="scrollbar-thin max-h-[340px] overflow-auto">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 z-[1] bg-muted/60">
            <tr>
              {columns.map((column, index) => (
                <th key={column} className="px-2.5 py-1.5 text-left font-medium text-foreground/75">
                  <button
                    type="button"
                    onClick={() => handleSort(index)}
                    className="inline-flex items-center gap-0.5 transition-colors hover:text-foreground"
                  >
                    {column}
                    <span className="text-[9px] text-muted-foreground">
                      {sort?.index === index ? (sort.direction === 1 ? '↑' : '↓') : ''}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
            {!spreadsheet && (
              <tr>
                {columns.map((column, index) => (
                  <th key={column} className="px-1 py-1">
                    <input
                      type="text"
                      value={filters[index] ?? ''}
                      onChange={(event) =>
                        setFilters((current) => ({ ...current, [index]: event.target.value }))
                      }
                      placeholder={`筛选 ${column}`}
                      aria-label={`筛选 ${column}`}
                      className="h-6 w-full rounded border border-border/60 bg-background/40 px-1.5 text-[11px] text-foreground outline-none"
                    />
                  </th>
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {visibleRows.length === 0 ? (
              <tr>
                <td colSpan={columns.length || 1} className="px-2.5 py-6 text-center text-muted-foreground">
                  无匹配数据
                </td>
              </tr>
            ) : groupData ? (
              groupData.flatMap(([group, groupRows]) => {
                const isCollapsed = collapsed.has(group)
                return [
                  <tr
                    key={`group-${group}`}
                    className="cursor-pointer border-t border-border/60 bg-muted/25"
                    onClick={() =>
                      setCollapsed((current) => {
                        const next = new Set(current)
                        if (next.has(group)) next.delete(group)
                        else next.add(group)
                        return next
                      })
                    }
                  >
                    <td colSpan={columns.length || 1} className="px-2.5 py-1 text-foreground/80">
                      <span
                        className={cn('mr-1 inline-block text-[9px] text-muted-foreground transition-transform', !isCollapsed && 'rotate-90')}
                      >
                        ▸
                      </span>
                      {columns[groupIndex]}: {group}
                      <span className="ml-1 text-muted-foreground">({groupRows.length})</span>
                    </td>
                  </tr>,
                  ...(isCollapsed
                    ? []
                    : groupRows.map((row, index) => renderRow(row, `${group}-${index}`))),
                ]
              })
            ) : (
              visibleRows.map((row, index) => renderRow(row, String(index)))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )

  return (
    <RichFrame
      title={spreadsheet ? 'Spreadsheet' : 'Data table'}
      actions={
        <>
          <button
            type="button"
            onClick={exportCsv}
            className="rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            title="导出 CSV"
          >
            CSV
          </button>
          {spreadsheet && (
            <button
              type="button"
              onClick={() => void exportXlsx()}
              className="rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
              title="导出 XLSX"
            >
              XLSX
            </button>
          )}
        </>
      }
      copyValue={code}
      fullscreen
      fullscreenTitle={spreadsheet ? 'Spreadsheet' : 'Data table'}
    >
      {table}
    </RichFrame>
  )
}
