/**
 * MentionText — 把文中的 @角色 渲染成圆角矩形芯片（非纯文本）
 *
 * 有 roles 时走 parseMentions（与发送解析一致）；无 roles 时用宽松正则兜底，
 * 避免历史消息/无角色表时仍显示纯 @ 字串。
 */
import { useMemo, type ReactNode } from 'react'
import { parseMentions } from '@tagent/shared'
import { AppTooltip } from '@tagent/ui'
import { cn } from '../../lib/utils'

export type MentionRoleLite = { id: string; displayName: string }

export function MentionText({
  text,
  roles,
  className,
  chipClassName,
}: {
  text: string
  roles?: MentionRoleLite[]
  className?: string
  chipClassName?: string
}): React.ReactElement {
  const parts = useMemo(() => splitMentionParts(text, roles), [text, roles])

  return (
    <span className={cn('mention-text', className)}>
      {parts.map((p, i) =>
        p.kind === 'mention' ? (
          <AppTooltip key={`m-${i}-${p.raw}`} label={p.raw}>
            <span className={cn('mention-chip', chipClassName)}>
              @{p.displayName}
            </span>
          </AppTooltip>
        ) : (
          <span key={`t-${i}`} className="mention-text__plain">
            {p.text}
          </span>
        ),
      )}
    </span>
  )
}

type Part =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; raw: string; displayName: string; roleId?: string }

export function splitMentionParts(text: string, roles?: MentionRoleLite[]): Part[] {
  if (!text) return []

  if (roles && roles.length > 0) {
    const hits = parseMentions(text, roles)
    if (hits.length === 0) return [{ kind: 'text', text }]
    const parts: Part[] = []
    let cursor = 0
    for (const h of hits) {
      if (h.index > cursor) {
        parts.push({ kind: 'text', text: text.slice(cursor, h.index) })
      }
      parts.push({
        kind: 'mention',
        raw: h.raw,
        displayName: h.displayName,
        roleId: h.roleId,
      })
      cursor = h.index + h.raw.length
    }
    if (cursor < text.length) {
      parts.push({ kind: 'text', text: text.slice(cursor) })
    }
    return parts
  }

  // 无角色表：@ 后跟中英文/数字/下划线/连字符，遇空白或标点结束
  const re = /@([\w\u4e00-\u9fff][\w\u4e00-\u9fff·.-]*)/g
  const parts: Part[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) != null) {
    if (m.index > last) {
      parts.push({ kind: 'text', text: text.slice(last, m.index) })
    }
    parts.push({
      kind: 'mention',
      raw: m[0],
      displayName: m[1] ?? m[0].slice(1),
    })
    last = m.index + m[0].length
  }
  if (last < text.length) {
    parts.push({ kind: 'text', text: text.slice(last) })
  }
  return parts.length > 0 ? parts : [{ kind: 'text', text }]
}

/** 仅芯片（无前后文），用于铭牌列表 */
export function MentionChip({
  label,
  className,
}: {
  label: string
  className?: string
}): React.ReactElement {
  const name = label.startsWith('@') ? label.slice(1) : label
  return (
    <AppTooltip label={`@${name}`}>
      <span className={cn('mention-chip', className)}>
        @{name}
      </span>
    </AppTooltip>
  )
}

/** 供需要 ReactNode 列表时使用 */
export function renderMentionLabels(labels: string[]): ReactNode {
  return labels.map((label) => <MentionChip key={label} label={label} />)
}
