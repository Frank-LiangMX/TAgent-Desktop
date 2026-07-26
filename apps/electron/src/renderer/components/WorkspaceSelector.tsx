/**
 * WorkspaceSelector — 顶栏工作区选择器
 *
 * 显示当前 workspace 名称，点击弹出 workspace 列表，
 * 可切换 workspace 或新建（打开项目目录）。
 * 数据从 Jotai atoms 读取，无需 props。
 */
import { useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  workspacesAtom,
  currentWorkspaceIdAtom,
  currentWorkspaceAtom,
  loadWorkspacesAtom,
} from '../atoms/workspace-atoms'
import { Button, Badge, Popover, PopoverTrigger, PopoverContent } from '@tagent/ui'
import { cn } from '../lib/utils'

export function WorkspaceSelector(): JSX.Element {
  const workspaces = useAtomValue(workspacesAtom)
  const currentId = useAtomValue(currentWorkspaceIdAtom)
  const current = useAtomValue(currentWorkspaceAtom)
  const loadWorkspaces = useSetAtom(loadWorkspacesAtom)
  const [switching, setSwitching] = useState(false)

  /** 切换 workspace */
  const handleSwitch = async (id: string): Promise<void> => {
    if (id === currentId) return
    setSwitching(true)
    const result = await window.electronAPI.switchWorkspace(id)
    if (result.ok) {
      // 切换成功后重新拉取列表（主进程会更新 getCurrentWorkspace）
      await loadWorkspaces()
    } else {
      alert(`切换失败：${result.error ?? '未知错误'}`)
    }
    setSwitching(false)
  }

  /** 打开项目目录 → 创建 workspace */
  const handleOpenProject = async (): Promise<void> => {
    setSwitching(true)
    const ws = await window.electronAPI.createProjectWorkspace()
    if (ws) {
      // 创建成功后重新拉取列表
      await loadWorkspaces()
    }
    setSwitching(false)
  }

  // 无 workspace 时显示引导按钮
  if (workspaces.length === 0) {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={switching}
        onClick={() => void handleOpenProject()}
        className="text-xs"
      >
        打开项目目录
      </Button>
    )
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={switching}
          className="text-xs gap-1.5 px-2 h-7"
        >
          {/* 当前 workspace 名称 */}
          <span className="font-medium">
            {current ? current.name : '未选择工作区'}
          </span>
          {current?.projectDirectory && (
            <Badge variant="outline" className="text-[10px] h-4 px-1">
              {shortenPath(current.projectDirectory)}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-auto min-w-[220px] p-2">
        <div className="space-y-1">
          {/* workspace 列表 */}
          {workspaces.map((ws) => (
            <button
              key={ws.id}
              onClick={() => void handleSwitch(ws.id)}
              className={cn(
                'w-full text-left px-2 py-1.5 rounded-glass-popover text-xs transition-colors',
                'hover:bg-accent',
                ws.id === currentId && 'bg-accent font-medium'
              )}
            >
              <div className="flex items-center gap-1.5">
                <span>{ws.name}</span>
                {ws.projectDirectory && (
                  <span className="text-muted-foreground text-[10px] truncate">
                    {shortenPath(ws.projectDirectory)}
                  </span>
                )}
              </div>
            </button>
          ))}

          {/* 分隔线 */}
          <div className="border-t my-1.5" />

          {/* 打开项目按钮 */}
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-xs justify-start"
            disabled={switching}
            onClick={() => void handleOpenProject()}
          >
            + 打开项目目录
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** 截断路径：只显示最后两级目录 */
function shortenPath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  // 取最后两级（如 C:/Users/.../my-project → .../my-project）
  if (parts.length > 2) {
    return '.../' + parts.slice(-2).join('/')
  }
  return path
}
