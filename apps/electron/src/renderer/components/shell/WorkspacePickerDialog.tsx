import type { AgentWorkspace } from '@tagent/shared'
import { FolderOpen } from '@phosphor-icons/react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@tagent/ui'

interface WorkspacePickerDialogProps {
  open: boolean
  workspaces: AgentWorkspace[]
  onOpenChange: (open: boolean) => void
  onSelect: (workspace: AgentWorkspace) => void
  onOpenProject: () => void
}

export function WorkspacePickerDialog({
  open,
  workspaces,
  onOpenChange,
  onSelect,
  onOpenProject,
}: WorkspacePickerDialogProps): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="workspace-picker">
        <DialogHeader>
          <DialogTitle>新会话保存到哪个项目？</DialogTitle>
          <DialogDescription>
            项目目录会成为这个会话的运行目录，创建后不会随其他界面状态改变。
          </DialogDescription>
        </DialogHeader>

        <div className="workspace-picker__list">
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              className="workspace-picker__item"
              onClick={() => onSelect(workspace)}
            >
              <FolderOpen size={17} weight="regular" aria-hidden="true" />
              <span>
                <strong>{workspace.name}</strong>
                <small>{workspace.projectDirectory ?? workspace.id}</small>
              </span>
            </button>
          ))}
        </div>

        <button
          type="button"
          className="workspace-picker__add"
          onClick={onOpenProject}
        >
          <FolderOpen size={15} weight="regular" aria-hidden="true" />
          打开其他项目
        </button>
      </DialogContent>
    </Dialog>
  )
}
