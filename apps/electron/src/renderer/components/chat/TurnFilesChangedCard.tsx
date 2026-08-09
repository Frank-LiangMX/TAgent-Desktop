/**
 * 句尾「N 个文件已更改」——视觉对齐 Cursor Files Changed：
 * 扁平行（无 chip 底）、固定宽语言标、右侧 +/-、超出折叠 Show more。
 */
import { useContext, useState } from 'react'
import { MessageFilePathContext, AppTooltip } from '@tagent/ui'
import type { TurnEditedFile } from './concise-timeline-model'

interface TurnFilesChangedCardProps {
  files: TurnEditedFile[]
}

/** 首屏展示条数（对齐 Cursor 默认折叠） */
const PREVIEW_COUNT = 4

type LangBadge = { label: string; tone: 'react' | 'ts' | 'css' | 'md' | 'code' | 'text' }

function langBadgeForName(name: string): LangBadge {
  const lower = name.toLowerCase()
  const ext = (lower.includes('.') ? lower.split('.').pop() : '') || ''
  /* 标签尽量 ≤2 字，保证 16px 方标内对齐（对齐 Cursor 文件类型图标宽度） */
  if (ext === 'tsx' || ext === 'jsx') return { label: 'R', tone: 'react' }
  if (ext === 'ts' || ext === 'mts' || ext === 'cts') return { label: 'TS', tone: 'ts' }
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return { label: 'JS', tone: 'ts' }
  if (ext === 'css' || ext === 'scss' || ext === 'less') return { label: '#', tone: 'css' }
  if (ext === 'md' || ext === 'mdc' || ext === 'mdx') return { label: 'MD', tone: 'md' }
  if (ext === 'cpp' || ext === 'cc' || ext === 'cxx') return { label: 'C+', tone: 'code' }
  if (ext === 'hpp' || ext === 'hh' || ext === 'h') return { label: 'H', tone: 'code' }
  if (ext === 'c') return { label: 'C', tone: 'code' }
  if (ext === 'cs' || lower.endsWith('.build.cs')) return { label: 'C#', tone: 'code' }
  if (ext === 'py') return { label: 'PY', tone: 'code' }
  if (ext === 'go') return { label: 'GO', tone: 'code' }
  if (ext === 'rs') return { label: 'RS', tone: 'code' }
  if (ext === 'json' || ext === 'jsonc') return { label: '{}', tone: 'text' }
  return { label: '·', tone: 'text' }
}

function FileLangBadge({ name }: { name: string }): JSX.Element {
  const { label, tone } = langBadgeForName(name)
  return (
    <span
      className={`agent-files-changed__badge agent-files-changed__badge--${tone}`}
      aria-hidden
    >
      {label}
    </span>
  )
}

export function TurnFilesChangedCard({ files }: TurnFilesChangedCardProps): JSX.Element | null {
  const { onOpenFile, basePaths } = useContext(MessageFilePathContext)
  const [expanded, setExpanded] = useState(false)
  if (files.length === 0) return null

  const open = (path: string): void => {
    if (!onOpenFile) return
    onOpenFile(path, basePaths?.length ? { basePaths } : undefined)
  }

  const hidden = Math.max(0, files.length - PREVIEW_COUNT)
  const visible = expanded || hidden === 0 ? files : files.slice(0, PREVIEW_COUNT)
  const canOpen = Boolean(onOpenFile)

  return (
    <div className="agent-files-changed" role="region" aria-label="本轮更改的文件">
      <div className="agent-files-changed__head">
        <span className="agent-files-changed__title">
          {files.length} {files.length === 1 ? 'File Changed' : 'Files Changed'}
        </span>
        {canOpen ? (
          <AppTooltip label={`在分屏中预览 ${files[0]!.name}`}>
            <button
              type="button"
              className="agent-files-changed__review"
              onClick={() => open(files[0]!.path)}
            >
              Review
            </button>
          </AppTooltip>
        ) : null}
      </div>
      <ul className="agent-files-changed__list">
        {visible.map((f) => (
          <li key={f.path} className="agent-files-changed__item">
            <AppTooltip label={canOpen ? `打开 ${f.path}` : f.path} multiline>
              <span className="block">
                <button
                  type="button"
                  className="agent-files-changed__row"
                  onClick={() => open(f.path)}
                  disabled={!canOpen}
                >
                  <FileLangBadge name={f.name} />
                  <span className="agent-files-changed__name">{f.name}</span>
                  <span className="agent-files-changed__diff" aria-label="行变更">
                    {f.add > 0 ? (
                      <span className="agent-files-changed__add">+{f.add}</span>
                    ) : null}
                    {f.del > 0 ? (
                      <span className="agent-files-changed__del">-{f.del}</span>
                    ) : null}
                  </span>
                </button>
              </span>
            </AppTooltip>
          </li>
        ))}
      </ul>
      {!expanded && hidden > 0 ? (
        <button
          type="button"
          className="agent-files-changed__more"
          onClick={() => setExpanded(true)}
        >
          <span className="agent-files-changed__more-dots" aria-hidden>
            …
          </span>
          Show {hidden} more
        </button>
      ) : null}
    </div>
  )
}
