/**
 * 新建协作室表单。
 *
 * 工作区是可选绑定：绑定后，协作室发布的产物可以落到该项目目录；
 * 不绑定也不影响聊天、建任务和成员协作。
 */
import { useEffect, useState } from 'react'
import type { CreateCollaborationRoomInput } from '@tagent/shared'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Textarea,
} from '@tagent/ui'
import { WorkspaceSelector } from '../chat/WorkspaceSelector'

export interface CollaborationCreateRoomDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultWorkspaceId?: string
  onSubmit: (input: CreateCollaborationRoomInput) => Promise<void> | void
  onOpenProject: () => Promise<string | undefined> | string | undefined
}

export function CollaborationCreateRoomDialog({
  open,
  onOpenChange,
  defaultWorkspaceId,
  onSubmit,
  onOpenProject,
}: CollaborationCreateRoomDialogProps): JSX.Element {
  const [title, setTitle] = useState('新协作室')
  const [goal, setGoal] = useState('')
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(defaultWorkspaceId)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    setTitle('新协作室')
    setGoal('')
    setWorkspaceId(defaultWorkspaceId)
    setSubmitting(false)
  }, [defaultWorkspaceId, open])

  const submit = async (): Promise<void> => {
    const trimmedTitle = title.trim()
    if (!trimmedTitle || submitting) return

    setSubmitting(true)
    try {
      await onSubmit({
        title: trimmedTitle,
        goal: goal.trim() || undefined,
        workspaceId,
        members: [{ displayName: '协调者', isCoordinator: true }],
      })
    } finally {
      setSubmitting(false)
    }
  }

  const selectProject = async (): Promise<void> => {
    const nextWorkspaceId = await onOpenProject()
    if (nextWorkspaceId) setWorkspaceId(nextWorkspaceId)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(480px,calc(100vw-32px))] gap-5 p-5 sm:max-w-none">
        <DialogHeader className="space-y-2 text-left">
          <DialogTitle className="text-[15px]">新建协作室</DialogTitle>
          <DialogDescription className="text-[12.5px] leading-5">
            先确定协作目标，之后可以再添加成员、分派任务或发布产物。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label className="text-xs text-muted-foreground" htmlFor="collab-create-title">
              名称
            </label>
            <Input
              id="collab-create-title"
              className="mt-1.5"
              value={title}
              placeholder="例如：版本发布、竞品分析"
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void submit()
                }
              }}
              autoFocus
              disabled={submitting}
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground" htmlFor="collab-create-goal">
              目标（可选）
            </label>
            <Textarea
              id="collab-create-goal"
              className="mt-1.5 min-h-20 resize-y text-sm"
              value={goal}
              placeholder="告诉协调者这间协作室要完成什么"
              onChange={(event) => setGoal(event.target.value)}
              disabled={submitting}
            />
          </div>

          <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium text-foreground">绑定工作区（可选）</p>
                <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                  绑定后，成员发布的产物会写入该项目目录；不绑定仍可聊天和建任务。
                </p>
              </div>
              <WorkspaceSelector
                value={workspaceId}
                onSelect={setWorkspaceId}
                onOpenProject={() => void selectProject()}
              />
            </div>
            {workspaceId ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-2 h-8 px-2 text-xs text-muted-foreground"
                onClick={() => setWorkspaceId(undefined)}
                disabled={submitting}
              >
                不绑定工作区
              </Button>
            ) : (
              <p className="mt-2 text-[11px] text-muted-foreground">当前不绑定工作区</p>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:justify-end">
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button type="button" size="sm" onClick={() => void submit()} disabled={submitting || !title.trim()}>
            {submitting ? '创建中…' : '创建协作室'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
