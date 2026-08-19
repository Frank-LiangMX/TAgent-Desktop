/**
 * 新建协作室表单。
 *
 * 工作区是可选绑定：绑定后，协作室发布的产物可以落到该项目目录；
 * 不绑定也不影响聊天、建任务和成员协作。
 */
import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type {
  AgentRoleProfile,
  Channel,
  CollaborationMemberPreset,
  CollaborationRoleSnapshot,
  CreateCollaborationMemberInput,
  CreateCollaborationRoomInput,
} from '@tagent/shared'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
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
  const [presets, setPresets] = useState<CollaborationMemberPreset[]>([])
  const [presetId, setPresetId] = useState('')
  const [presetName, setPresetName] = useState('')
  const [members, setMembers] = useState<CreateCollaborationMemberInput[]>([
    { displayName: '协调者', isCoordinator: true },
  ])
  const [channels, setChannels] = useState<Channel[]>([])
  const [roles, setRoles] = useState<AgentRoleProfile[]>([])
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    setTitle('新协作室')
    setGoal('')
    setWorkspaceId(defaultWorkspaceId)
    setPresetId('')
    setPresetName('')
    setMembers([{ displayName: '协调者', isCoordinator: true }])
    setSubmitting(false)
    void Promise.all([
      window.electronAPI.listCollaborationMemberPresets(),
      window.electronAPI.listChannels(),
      window.electronAPI.listAgentRoles(),
    ]).then(([nextPresets, nextChannels, nextRoles]) => {
      setPresets(Array.isArray(nextPresets) ? nextPresets : [])
      setChannels(Array.isArray(nextChannels) ? nextChannels : [])
      setRoles(Array.isArray(nextRoles) ? nextRoles : [])
    }).catch(() => {
      setPresets([])
      setChannels([])
      setRoles([])
    })
  }, [defaultWorkspaceId, open])

  const enabledChannels = useMemo(() => channels.filter((channel) => channel.enabled), [channels])

  const updateMember = (index: number, patch: Partial<CreateCollaborationMemberInput>): void => {
    setMembers((prev) => prev.map((member, i) => (i === index ? { ...member, ...patch } : member)))
  }

  const selectPreset = (id: string): void => {
    setPresetId(id === 'custom' ? '' : id)
    const preset = presets.find((item) => item.id === id)
    if (!preset) {
      if (id === 'custom') setMembers([{ displayName: '协调者', isCoordinator: true }])
      return
    }
    setMembers(JSON.parse(JSON.stringify(preset.members)) as CreateCollaborationMemberInput[])
  }

  const addMember = (): void => {
    setMembers((prev) => [...prev, { displayName: `成员 ${prev.length + 1}` }])
  }

  const removeMember = (index: number): void => {
    setMembers((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)))
  }

  const savePreset = async (): Promise<void> => {
    const name = presetName.trim()
    if (!name || members.length === 0) return
    try {
      const saved = await window.electronAPI.saveCollaborationMemberPreset({
        name,
        members,
      })
      setPresets((prev) => [saved, ...prev.filter((item) => item.id !== saved.id)])
      setPresetId(saved.id)
      setPresetName('')
    } catch (err) {
      console.error('[协作室] 保存成员配置失败:', err)
    }
  }

  const deletePreset = async (): Promise<void> => {
    if (!presetId) return
    const id = presetId
    await window.electronAPI.deleteCollaborationMemberPreset(id)
    setPresets((prev) => prev.filter((item) => item.id !== id))
    setPresetId('')
  }

  const submit = async (): Promise<void> => {
    const trimmedTitle = title.trim()
    if (!trimmedTitle || submitting) return

    setSubmitting(true)
    try {
      await onSubmit({
        title: trimmedTitle,
        goal: goal.trim() || undefined,
        workspaceId,
        members,
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
      <DialogContent className="flex h-[min(760px,calc(100vh-80px))] max-h-[calc(100vh-80px)] min-w-0 w-[min(520px,calc(100vw-32px))] flex-col gap-0 overflow-hidden !p-0 sm:max-w-none">
        <DialogHeader className="min-w-0 shrink-0 space-y-2 px-5 pt-5 text-left">
          <DialogTitle className="text-[15px]">新建协作室</DialogTitle>
          <DialogDescription className="text-[12.5px] leading-5">
            先确定协作目标，之后可以再添加成员、分派任务或发布产物。
          </DialogDescription>
        </DialogHeader>

        <div className="scrollbar-thin min-h-0 min-w-0 flex-1 space-y-4 overflow-auto px-5 pb-5 pt-5">
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

          <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-3">
            <div className="min-w-0">
              <p className="text-xs font-medium text-foreground">绑定工作区（可选）</p>
              <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                绑定后，成员发布的产物会写入该项目目录；不绑定仍可聊天和建任务。
              </p>
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <div className="min-w-0 flex-1">
                <WorkspaceSelector
                  value={workspaceId}
                  onSelect={setWorkspaceId}
                  onOpenProject={() => void selectProject()}
                  className="w-full max-w-none justify-start rounded-md border border-border/50 bg-background/30 px-2.5 py-2"
                />
              </div>
              {workspaceId ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 shrink-0 px-2 text-xs text-muted-foreground"
                  onClick={() => setWorkspaceId(undefined)}
                  disabled={submitting}
                >
                  不绑定工作区
                </Button>
              ) : (
                <p className="shrink-0 text-[11px] text-muted-foreground">当前不绑定工作区</p>
              )}
            </div>
          </div>

          <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium text-foreground">成员配置</p>
                <p className="mt-1 text-[11px] text-muted-foreground">可从常用配置开始，再按本房间调整。</p>
              </div>
              <div className="flex items-center gap-1.5">
                <Select value={presetId || 'custom'} onValueChange={selectPreset}>
                  <SelectTrigger className="h-8 w-40 text-xs">
                    <SelectValue placeholder="自定义成员" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="custom">自定义成员</SelectItem>
                    {presets.map((preset) => (
                      <SelectItem key={preset.id} value={preset.id}>{preset.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {presetId ? (
                  <Button type="button" variant="ghost" size="icon" className="size-8 text-muted-foreground" onClick={() => void deletePreset()} aria-label="删除成员配置">
                    <Trash2 className="size-3.5" />
                  </Button>
                ) : null}
              </div>
            </div>
            <div className="mt-3 space-y-2">
              {members.map((member, index) => {
                const channel = enabledChannels.find((item) => item.id === member.channelId)
                const models = channel?.models.filter((model) => model.enabled) ?? []
                const rolePrompt = member.roleSnapshot?.systemPrompt ?? ''
                return (
                  <div key={index} className="rounded-md border border-border/50 bg-background/35 p-2.5">
                    <div className="flex items-center gap-2">
                      <Input
                        className="h-8 min-w-0 flex-1 text-xs"
                        value={member.displayName}
                        placeholder="成员名称"
                        onChange={(event) => updateMember(index, { displayName: event.target.value })}
                      />
                      <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                        <Switch size="sm" checked={member.isCoordinator === true} onCheckedChange={(checked) => updateMember(index, { isCoordinator: checked })} />
                        协调者
                      </label>
                      <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground" onClick={() => removeMember(index)} disabled={members.length <= 1} aria-label="删除成员">
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <Select
                        value={member.channelId || 'auto'}
                        onValueChange={(value) => updateMember(index, { channelId: value === 'auto' ? undefined : value, modelId: undefined })}
                      >
                        <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="自动渠道" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">自动渠道（kscc 优先）</SelectItem>
                          {enabledChannels.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <Select
                        value={member.modelId || 'default'}
                        onValueChange={(value) => updateMember(index, { modelId: value === 'default' ? undefined : value })}
                        disabled={!member.channelId || models.length === 0}
                      >
                        <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="渠道默认模型" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="default">渠道默认模型</SelectItem>
                          {models.map((model) => <SelectItem key={model.id} value={model.id}>{model.name || model.id}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <Textarea
                      className="mt-2 min-h-14 resize-y text-xs"
                      value={rolePrompt}
                      placeholder="角色说明（可选）：例如负责代码、测试或文档"
                      onChange={(event) => {
                        const prompt = event.target.value
                        const snapshot: CollaborationRoleSnapshot | undefined = prompt.trim()
                          ? { displayName: member.displayName || '自定义角色', description: '自定义角色', systemPrompt: prompt }
                          : undefined
                        updateMember(index, { roleSnapshot: snapshot })
                      }}
                    />
                    {member.roleId ? <p className="mt-1 text-[10px] text-muted-foreground">已保存角色库引用：{roles.find((role) => role.id === member.roleId)?.displayName ?? member.roleId}</p> : null}
                  </div>
                )
              })}
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={addMember}>
                <Plus className="mr-1.5 size-3.5" /> 添加成员
              </Button>
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <Input className="h-8 w-36 text-xs" value={presetName} placeholder="配置名称" onChange={(event) => setPresetName(event.target.value)} />
                <Button type="button" variant="ghost" size="sm" className="h-8 text-xs" onClick={() => void savePreset()} disabled={!presetName.trim()}>
                  保存为常用配置
                </Button>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="shrink-0 gap-2 px-5 pb-5 sm:justify-end">
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
