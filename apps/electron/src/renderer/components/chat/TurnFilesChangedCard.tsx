/**
 * 句尾「N 个文件已更改」——对齐 Cursor Files Changed 卡片。
 * Review / 行点击：走 MessageFilePathContext.onOpenFile → 右侧文件预览。
 */
import { useContext } from 'react'
import { MessageFilePathContext } from '@tagent/ui'
import type { TurnEditedFile } from './concise-timeline-model'

interface TurnFilesChangedCardProps {
  files: TurnEditedFile[]
}

export function TurnFilesChangedCard({ files }: TurnFilesChangedCardProps): JSX.Element | null {
  const { onOpenFile } = useContext(MessageFilePathContext)
  if (files.length === 0) return null

  const open = (path: string): void => {
    onOpenFile?.(path)
  }

  return (
    <div className="agent-files-changed" role="region" aria-label="本轮更改的文件">
      <div className="agent-files-changed__head">
        <span className="agent-files-changed__title">
          {files.length} {files.length === 1 ? 'File Changed' : 'Files Changed'}
        </span>
        {onOpenFile ? (
          <button
            type="button"
            className="agent-files-changed__review"
            onClick={() => open(files[0]!.path)}
          >
            Review
          </button>
        ) : null}
      </div>
      <ul className="agent-files-changed__list">
        {files.map((f) => (
          <li key={f.path}>
            <button
              type="button"
              className="agent-files-changed__row"
              onClick={() => open(f.path)}
              title={f.path}
            >
              <FileExtBadge name={f.name} />
              <span className="agent-files-changed__name">{f.name}</span>
              <span className="agent-files-changed__diff">
                {f.add > 0 ? (
                  <span className="agent-concise-diff__add">+{f.add}</span>
                ) : null}
                {f.del > 0 ? (
                  <span className="agent-concise-diff__del">-{f.del}</span>
                ) : null}
                {f.add === 0 && f.del === 0 ? (
                  <span className="agent-files-changed__diff-empty">·</span>
                ) : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function FileExtBadge({ name }: { name: string }): JSX.Element {
  const ext = (name.split('.').pop() || '').toLowerCase()
  const kind =
    ext === 'tsx' || ext === 'jsx'
      ? 'react'
      : ext === 'ts' || ext === 'js' || ext === 'mjs' || ext === 'cjs'
        ? 'ts'
        : ext === 'css' || ext === 'scss' || ext === 'less'
          ? 'css'
          : ext === 'json' || ext === 'md' || ext === 'mdc'
            ? 'data'
            : 'file'
  const label =
    kind === 'react' ? 'R' : kind === 'css' ? '#' : kind === 'ts' ? 'TS' : kind === 'data' ? '{}' : '·'
  return (
    <span className={`agent-files-changed__badge agent-files-changed__badge--${kind}`} aria-hidden>
      {label}
    </span>
  )
}
