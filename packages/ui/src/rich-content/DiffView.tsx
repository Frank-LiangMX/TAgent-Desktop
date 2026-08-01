/**
 * DiffView — unified diff 渲染（自研解析）
 *
 * 结构：文件头（old → new）+ 各 hunk（行号列 + +/-/空格 着色）。
 * 解析失败由上层回退普通代码块。红绿采用项目既有语义色
 * （success 绿 = settings-shell 的 hsl(145 …)，删除红 = destructive token）。
 */
import * as React from 'react'

import { countDiffChanges, parseUnifiedDiff } from './diff-parse'
import { RichFrame } from './RichFrame'

interface DiffViewProps {
  code: string
}

function fileName(path: string): string {
  const clean = path.replace(/^(a|b)\//, '')
  return clean === '/dev/null' ? '新文件' : clean
}

export function DiffView({ code }: DiffViewProps): React.ReactElement | null {
  const parsed = React.useMemo(() => parseUnifiedDiff(code), [code])
  if (!parsed) return null

  const { add, del } = countDiffChanges(parsed.hunks)
  const title = `${fileName(parsed.newPath || parsed.oldPath)} · +${add} −${del}`

  return (
    <RichFrame title={title} copyValue={code} fullscreen fullscreenTitle={title}>
      <div className="diff-view text-xs leading-[1.6]">
        {parsed.hunks.map((hunk, hunkIndex) => {
          let oldLine = hunk.oldStart
          let newLine = hunk.newStart
          return (
            <div key={hunkIndex} className="diff-hunk">
              <div className="diff-hunk-head select-none bg-muted/40 px-3 py-0.5 font-mono text-muted-foreground">
                @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
              </div>
              {hunk.lines.map((line, lineIndex) => {
                const row = (
                  <span
                    key={lineIndex}
                    className={`diff-line diff-line--${line.type}`}
                    data-type={line.type}
                  >
                    <span className="diff-line-num select-none">{line.type === 'add' ? '' : oldLine}</span>
                    <span className="diff-line-num select-none">{line.type === 'del' ? '' : newLine}</span>
                    <span className="diff-line-mark select-none">{line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}</span>
                    <span className="diff-line-text">{line.text}</span>
                  </span>
                )
                if (line.type === 'add') newLine++
                else if (line.type === 'del') oldLine++
                else {
                  oldLine++
                  newLine++
                }
                return row
              })}
            </div>
          )
        })}
      </div>
    </RichFrame>
  )
}
