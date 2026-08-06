/**
 * JsonTree — JSON 折叠树（自研）
 *
 * 递归渲染任意 JSON：对象/数组可展开收起（默认展开前两层），
 * 原始值按类型着色（字符串/数字/布尔/空）。解析失败由上层回落代码块。
 */
import * as React from 'react'

import { cn } from '../lib/utils'
import { RichFrame } from './RichFrame'

interface JsonTreeProps {
  code: string
  variant?: 'default' | 'pane'
}

function parse(source: string): unknown | null {
  try {
    return JSON.parse(source)
  } catch {
    return null
  }
}

type JsonValue = unknown

function isEmptyContainer(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.length === 0
  if (value && typeof value === 'object') return Object.keys(value as Record<string, unknown>).length === 0
  return false
}

function previewText(value: JsonValue): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return `"${value.slice(0, 40)}${value.length > 40 ? '…' : ''}"`
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `Array(${value.length})`
  if (typeof value === 'object') return `{…}`
  return String(value)
}

function JsonPrimitive({ value }: { value: JsonValue }): React.ReactElement {
  if (value === null) return <span className="json-node json-node--null">null</span>
  if (typeof value === 'string') return <span className="json-node json-node--string">"{value}"</span>
  if (typeof value === 'number') return <span className="json-node json-node--number">{String(value)}</span>
  if (typeof value === 'boolean') return <span className="json-node json-node--boolean">{String(value)}</span>
  if (value === undefined) return <span className="json-node json-node--null">undefined</span>
  return <span className="json-node">{previewText(value)}</span>
}

interface JsonNodeProps {
  name: string
  value: JsonValue
  depth: number
}

/** 容器节点（object/array）：可折叠 */
function JsonContainer({ name, value, depth }: JsonNodeProps): React.ReactElement {
  const [open, setOpen] = React.useState(depth < 2)
  const isArray = Array.isArray(value)
  const entries: Array<{ key: string; item: JsonValue }> = isArray
    ? (value as unknown[]).map((item, index) => ({ key: String(index), item }))
    : Object.entries(value as Record<string, unknown>).map(([key, item]) => ({ key, item }))
  const empty = isEmptyContainer(value)

  return (
    <div className="json-node json-node--container">
      <div className="flex items-start gap-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={empty}
          className={cn(
            'json-node-toggle select-none text-muted-foreground/60 transition-transform',
            open && 'open',
            empty && 'invisible',
          )}
          aria-label={open ? '收起' : '展开'}
        >
          ▸
        </button>
        <span className="json-node-key">{name}: </span>
        {!open ? (
          <span className="text-foreground/80">
            {isArray ? '[' : '{'}
            <span className="text-muted-foreground">{previewText(value).slice(4)}</span>
          </span>
        ) : (
          <span className="text-foreground/80">{isArray ? '[' : '{'}</span>
        )}
      </div>

      {open && (
        <div className="json-node-children ml-3.5 border-l border-border/60 pl-2">
          {entries.map(({ key, item }) => (
            <div key={key}>
              {Array.isArray(item) || (item !== null && typeof item === 'object') ? (
                <JsonContainer name={key} value={item} depth={depth + 1} />
              ) : (
                <div className="flex items-start gap-1 py-px">
                  <span className="json-node-toggle invisible select-none">▸</span>
                  <span className="json-node-key">{key}: </span>
                  <JsonPrimitive value={item} />
                </div>
              )}
            </div>
          ))}
          <div className="text-foreground/80">{isArray ? ']' : '}'}</div>
        </div>
      )}
    </div>
  )
}

export function JsonTree({
  code,
  variant = 'default',
}: JsonTreeProps): React.ReactElement | null {
  const value = React.useMemo(() => parse(code), [code])
  if (value === null) {
    // 解析失败（流式半截 / 模型输出坏 JSON）→ 提示而非空白（RichBlockBoundary 只捕 throw 不捕 null）
    return (
      <div className="rounded-lg border border-foreground/12 bg-foreground/[0.03] px-3 py-2.5 text-xs text-muted-foreground">
        JSON 内容无效（解析失败，可能不完整）
      </div>
    )
  }

  const isContainer = Array.isArray(value) || (typeof value === 'object' && value !== null)

  return (
    <RichFrame
      title="JSON"
      copyValue={code}
      fullscreen
      fullscreenTitle="JSON"
      splitKind={variant === 'default' ? 'json' : undefined}
      variant={variant}
    >
      <div className="json-tree px-3 py-2.5 font-mono text-xs text-foreground/90">
        {isContainer ? (
          <JsonContainer name="$" value={value} depth={0} />
        ) : (
          <JsonPrimitive value={value} />
        )}
      </div>
    </RichFrame>
  )
}
