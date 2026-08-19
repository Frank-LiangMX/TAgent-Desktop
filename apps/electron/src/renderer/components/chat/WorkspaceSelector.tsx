/**
 * 输入框尾部的工作区目录选择器（新会话页用）。
 *
 * 仿 ModelSelector：Popover + pill 触发按钮。列已注册工作区 + 「打开其他项目」
 * （走 createProjectWorkspace 原生目录选择）。仅草稿态可用——首条消息发送后工作区锁定。
 */
import { useState } from 'react'
import { useAtomValue } from 'jotai'
import { Popover, PopoverContent, PopoverTrigger } from '@tagent/ui'
import { Check, ChevronDown, FolderOpen } from 'lucide-react'
import { cn } from '../../lib/utils'
import { workspacesAtom } from '../../atoms/workspace-atoms'

interface WorkspaceSelectorProps {
  /** 当前选中工作区 id */
  value?: string
  onSelect: (id: string) => void
  /** 打开其他项目（原生目录选择 + 注册工作区） */
  onOpenProject: () => void
  /** 允许调用方调整触发器布局（例如在表单中占满一行） */
  className?: string
}

export function WorkspaceSelector({
  value,
  onSelect,
  onOpenProject,
  className,
}: WorkspaceSelectorProps): JSX.Element {
  const workspaces = useAtomValue(workspacesAtom)
  const [open, setOpen] = useState(false)
  const active = workspaces.find((w) => w.id === value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex min-w-0 max-w-[320px] items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors',
            'text-muted-foreground hover:bg-accent hover:text-foreground',
            className,
          )}
          aria-label="选择工作区"
        >
          <FolderOpen className="size-3.5 shrink-0" />
          <span className="min-w-0 shrink truncate font-medium text-foreground/85">
            {active?.name || '选择工作区'}
          </span>
          {active && (
            <span className="min-w-0 flex-1 truncate text-[10px] text-foreground/40">
              · {active.projectDirectory ?? active.id}
            </span>
          )}
          <ChevronDown className="size-3 shrink-0 opacity-70" />
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" side="top" className="w-[340px] overflow-hidden p-1">
        <div className="scrollbar-thin max-h-[340px] overflow-y-auto">
          {workspaces.length === 0 ? (
            <div className="px-2.5 py-2 text-xs text-muted-foreground">还没有工作区</div>
          ) : (
            workspaces.map((w) => {
              const selected = w.id === value
              return (
                <button
                  key={w.id}
                  type="button"
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs transition-colors',
                    'hover:bg-accent',
                  )}
                  onClick={() => {
                    onSelect(w.id)
                    setOpen(false)
                  }}
                >
                  <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-foreground/85">{w.name}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {w.projectDirectory ?? w.id}
                    </span>
                  </span>
                  {selected && <Check className="size-3.5 shrink-0 text-primary" />}
                </button>
              )
            })
          )}

          <div className="my-1 border-t border-border/55" />

          <button
            type="button"
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-muted-foreground',
              'transition-colors hover:bg-accent hover:text-foreground',
            )}
            onClick={() => {
              setOpen(false)
              onOpenProject()
            }}
          >
            <FolderOpen className="size-3.5 shrink-0" />
            打开其他项目…
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
