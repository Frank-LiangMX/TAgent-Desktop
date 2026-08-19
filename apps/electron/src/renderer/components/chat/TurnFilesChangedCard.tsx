/**
 * 句尾「N 个文件已更改」——视觉对齐 Cursor Files Changed：
 * 扁平行（无 chip 底）、固定宽语言标、右侧 +/-、超出折叠 Show more。
 *
 * 点 Review / 文件行 → onOpenFile 带 review 上下文（本轮全部文件 + 补丁），
 * 分屏走「本轮 unified diff 审阅」。正文文件 chip 不走此卡，仍只预览当前文件。
 */
import { useContext, useState } from 'react'
import { fileLangBadgeForName } from '@tagent/shared'
import type { FileEditPatch } from '@tagent/shared'
import { MessageFilePathContext, AppTooltip } from '@tagent/ui'
import type { TurnEditedFile } from './concise-timeline-model'

interface TurnFilesChangedCardProps {
  files: TurnEditedFile[]
  /** 本轮全部编辑补丁（跨文件），供分屏还原旧稿 / 算 unified diff */
  patches: FileEditPatch[]
}

/** 首屏展示条数（对齐 Cursor 默认折叠） */
const PREVIEW_COUNT = 4

function FileLangBadge({ name }: { name: string }): JSX.Element {
  const { label, tone } = fileLangBadgeForName(name)
  return (
    <span
      className={`agent-files-changed__badge agent-files-changed__badge--${tone}`}
      aria-hidden
    >
      {label}
    </span>
  )
}

export function TurnFilesChangedCard({ files, patches }: TurnFilesChangedCardProps): JSX.Element | null {
  const { onOpenFile, basePaths } = useContext(MessageFilePathContext)
  const [expanded, setExpanded] = useState(false)
  if (files.length === 0) return null

  const open = (path: string): void => {
    if (!onOpenFile) return
    onOpenFile(path, {
      basePaths: basePaths?.length ? basePaths : undefined,
      // 整卡 review：files = 本卡全部，patches = 本轮全部；分屏内按 activePath 过滤
      review: { files, patches },
    })
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
          <AppTooltip label={`在分屏中审阅 ${files[0]!.name}`}>
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
            <AppTooltip label={canOpen ? `审阅 ${f.path}` : f.path} multiline>
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
      {hidden > 0 ? (
        <button
          type="button"
          className="agent-files-changed__more"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            'Show less'
          ) : (
            <>
              <span className="agent-files-changed__more-dots" aria-hidden>
                …
              </span>
              Show {hidden} more
            </>
          )}
        </button>
      ) : null}
    </div>
  )
}
