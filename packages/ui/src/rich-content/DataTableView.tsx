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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/select'
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
  /** pane：分屏标签内嵌，隐藏再开分屏 */
  variant?: 'default' | 'pane'
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

export function DataTableView({
  code,
  spreadsheet = false,
  variant = 'default',
}: DataTableViewProps): React.ReactElement | null {
  const normalized = React.useMemo<NormalizedDataSpec | null>(() => {
    const spec = parseDataSpec(code)
    return normalizeDataSpec(spec)
  }, [code])

  const [query, setQuery] = React.useState('')
  const [filters, setFilters] = React.useState<Record<number, string>>({})
  const [showColFilters, setShowColFilters] = React.useState(false)
  const [sort, setSort] = React.useState<{ index: number; direction: 1 | -1 } | null>(null)
  const [groupIndex, setGroupIndex] = React.useState(-1)
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => new Set())

  const hasGroupBy =
    normalized !== null && groupIndex >= 0 && groupIndex < normalized.columns.length
  const activeFilterCount = Object.values(filters).filter((v) => v.trim()).length
  const showFilters = !spreadsheet && showColFilters


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
      <div className="rounded-lg border border-foreground/12 bg-foreground/[0.03] px-3 py-2.5 text-xs text-muted-foreground">
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

  const renderRow = (row: DataValue[], rowKey: string, zebra: boolean): React.ReactElement => (
    <tr key={rowKey} className={cn('data-table__row', zebra && 'data-table__row--zebra')}>
      {row.map((value, cellIndex) => {
        const type = columnDefs[cellIndex]?.type ?? 'text'
        const text = formatValue(value, type)
        return (
          <td
            key={cellIndex}
            className={cn(
              'data-table__td',
              type === 'number' && 'data-table__td--num',
              cellIndex === 0 && type === 'text' && 'data-table__td--key',
            )}
            title={text.length > 80 ? text : undefined}
          >
            {text}
          </td>
        )
      })}
    </tr>
  )

  const table = (
    <div
      className={cn(
        'data-table not-prose',
        variant === 'pane' && 'data-table--fill',
      )}
    >
      <div className="data-table__toolbar">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索…"
          className="data-table__search"
        />
        {!spreadsheet && columns.length > 0 && (
          <>
            <Select
              value={String(groupIndex)}
              onValueChange={(value) => setGroupIndex(Number(value))}
            >
              <SelectTrigger className="data-table__select" aria-label="分组">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" className="data-table__select-menu">
                <SelectItem value="-1">不分组</SelectItem>
                {columns.map((column, index) => (
                  <SelectItem key={column} value={String(index)}>
                    按 {column}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <button
              type="button"
              className={cn(
                'data-table__filter-toggle',
                (showColFilters || activeFilterCount > 0) && 'is-active',
              )}
              aria-pressed={showColFilters}
              onClick={() => setShowColFilters((v) => !v)}
              title="按列筛选"
            >
              筛选{activeFilterCount > 0 ? ` ${activeFilterCount}` : ''}
            </button>
          </>
        )}
        <span className="data-table__count">{visibleRows.length} 行</span>
      </div>

      <div className="data-table__scroll scrollbar-thin">
        {/*
          sticky 挂在 th 上；border-separate 避免双行表头被压扁叠到首行。
          列筛选默认收起，避免表头区输入框墙。
        */}
        <table className="data-table__table">
          <thead>
            <tr>
              {columns.map((column, index) => (
                <th key={column} className="data-table__th data-table__th--head">
                  <button type="button" onClick={() => handleSort(index)} className="data-table__sort">
                    <span>{column}</span>
                    <span className="data-table__sort-mark" aria-hidden>
                      {sort?.index === index ? (sort.direction === 1 ? '↑' : '↓') : ''}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
            {showFilters && (
              <tr>
                {columns.map((column, index) => (
                  <th key={column} className="data-table__th data-table__th--filter">
                    <input
                      type="text"
                      value={filters[index] ?? ''}
                      onChange={(event) =>
                        setFilters((current) => ({ ...current, [index]: event.target.value }))
                      }
                      placeholder={column}
                      aria-label={`筛选 ${column}`}
                      className="data-table__col-filter"
                    />
                  </th>
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {visibleRows.length === 0 ? (
              <tr>
                <td colSpan={columns.length || 1} className="data-table__empty">
                  无匹配数据
                </td>
              </tr>
            ) : groupData ? (
              groupData.flatMap(([group, groupRows]) => {
                const isCollapsed = collapsed.has(group)
                return [
                  <tr
                    key={`group-${group}`}
                    className="data-table__group"
                    onClick={() =>
                      setCollapsed((current) => {
                        const next = new Set(current)
                        if (next.has(group)) next.delete(group)
                        else next.add(group)
                        return next
                      })
                    }
                  >
                    <td colSpan={columns.length || 1}>
                      <span
                        className={cn('data-table__group-caret', !isCollapsed && 'is-open')}
                        aria-hidden
                      >
                        ▸
                      </span>
                      {columns[groupIndex]}: {group}
                      <span className="data-table__group-count">({groupRows.length})</span>
                    </td>
                  </tr>,
                  ...(isCollapsed
                    ? []
                    : groupRows.map((row, index) =>
                        renderRow(row, `${group}-${index}`, index % 2 === 1),
                      )),
                ]
              })
            ) : (
              visibleRows.map((row, index) => renderRow(row, String(index), index % 2 === 1))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )

  return (
    <RichFrame
      title={spreadsheet ? 'Spreadsheet' : 'Data table'}
      variant={variant}
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
      splitKind={variant === 'default' ? (spreadsheet ? 'spreadsheet' : 'datatable') : undefined}
    >
      {table}
    </RichFrame>
  )
}
