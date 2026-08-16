/**
 * 协作室「添加成员」弹出面板（对齐模型选择器形态：锚定按钮的 Popover，不做全局弹窗）。
 *
 * 字段：显示名 + 内核（渠道）+ 模型 + 是否协调者 + 角色（角色库 / 自定义 prompt）。
 * - 内核 = 渠道（kscc 内网走 kscc CLI；外部渠道走 Pi HTTP）
 * - 不选渠道时由主进程自动绑定默认渠道（kscc 优先），与建房间行为一致
 * - 模型随渠道联动；选「渠道默认」则不传 modelId
 * 表单控件全部用 @tagent/ui 主题化组件（Input / Select / Textarea / Switch）。
 */
import { useEffect, useMemo, useState } from 'react'
import { UserPlus } from '@phosphor-icons/react'
import {
  Button,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from '@tagent/ui'
import type {
  AgentRoleProfile,
  Channel,
  CollaborationRoleSnapshot,
} from '@tagent/shared'

type RoleMode = 'none' | 'library' | 'custom'

export interface CollaborationAddMemberDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  disabled?: boolean
  channels: Channel[]
  onSave: (patch: {
    displayName: string
    channelId: string
    modelId: string
    isCoordinator: boolean
    roleId?: string
    roleSnapshot?: CollaborationRoleSnapshot
  }) => void
}

export function CollaborationAddMemberDialog({
  open,
  onOpenChange,
  disabled = false,
  channels,
  onSave,
}: CollaborationAddMemberDialogProps): JSX.Element {
  const [displayName, setDisplayName] = useState('')
  const [channelId, setChannelId] = useState('')
  const [modelId, setModelId] = useState('')
  const [isCoordinator, setIsCoordinator] = useState(false)
  const [roles, setRoles] = useState<AgentRoleProfile[]>([])
  const [roleMode, setRoleMode] = useState<RoleMode>('none')
  const [selectedRoleId, setSelectedRoleId] = useState('')
  const [customPrompt, setCustomPrompt] = useState('')

  // 每次打开重置表单
  useEffect(() => {
    if (!open) return
    setDisplayName('')
    setChannelId('')
    setModelId('')
    setIsCoordinator(false)
    setRoleMode('none')
    setSelectedRoleId('')
    setCustomPrompt('')
    void window.electronAPI
      .listAgentRoles()
      .then(setRoles)
      .catch(() => setRoles([]))
  }, [open])

  const enabledChannels = useMemo(
    () => channels.filter((c) => c.enabled),
    [channels],
  )
  const selectedChannel = enabledChannels.find((c) => c.id === channelId)
  const enabledModels = selectedChannel?.models.filter((m) => m.enabled) ?? []
  const selectedRole = roles.find((r) => r.id === selectedRoleId) ?? null

  const submit = (): void => {
    const name =
      displayName.trim() ||
      (roleMode === 'library' && selectedRole ? selectedRole.displayName : '')
    if (!name) return

    let roleId: string | undefined
    let roleSnapshot: CollaborationRoleSnapshot | undefined
    if (roleMode === 'library' && selectedRole) {
      roleId = selectedRole.id
      roleSnapshot = {
        roleId: selectedRole.id,
        displayName: selectedRole.displayName,
        description: selectedRole.description,
        systemPrompt: selectedRole.systemPrompt,
      }
    } else if (roleMode === 'custom' && customPrompt.trim()) {
      roleSnapshot = {
        displayName: name,
        description: '自定义角色',
        systemPrompt: customPrompt.trim(),
      }
    }

    onSave({ displayName: name, channelId, modelId, isCoordinator, roleId, roleSnapshot })
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          aria-label="添加成员"
          disabled={disabled}
        >
          <UserPlus size={14} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" sideOffset={6} className="w-80">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-foreground">添加成员</h2>
          <span className="text-[11px] text-muted-foreground">不选渠道 = 自动（kscc 优先）</span>
        </div>

        <label className="mt-3 block text-xs text-muted-foreground" htmlFor="collab-add-member-name">
          显示名
        </label>
        <Input
          id="collab-add-member-name"
          className="mt-1"
          value={displayName}
          placeholder="例如：开发、测试、文档"
          onChange={(e) => setDisplayName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onOpenChange(false)
            }
          }}
          autoFocus
        />

        <label className="mt-3 block text-xs text-muted-foreground" htmlFor="collab-add-member-channel">
          内核（渠道）
        </label>
        <Select
          value={channelId || 'auto'}
          onValueChange={(v) => {
            setChannelId(v === 'auto' ? '' : v)
            setModelId('')
          }}
        >
          <SelectTrigger id="collab-add-member-channel" className="mt-1">
            <SelectValue placeholder="自动（kscc 优先）" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">自动（kscc 优先）</SelectItem>
            {enabledChannels.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {enabledChannels.length === 0 ? (
          <p className="mt-1.5 text-xs text-amber-600">
            没有已启用的渠道，成员将无法回复。请先到设置启用渠道。
          </p>
        ) : null}

        <label className="mt-3 block text-xs text-muted-foreground" htmlFor="collab-add-member-model">
          模型
        </label>
        <Select
          value={modelId || 'default'}
          onValueChange={(v) => setModelId(v === 'default' ? '' : v)}
          disabled={!channelId || enabledModels.length === 0}
        >
          <SelectTrigger id="collab-add-member-model" className="mt-1">
            <SelectValue
              placeholder={
                channelId
                  ? enabledModels.length > 0
                    ? '渠道默认'
                    : '该渠道无可用模型'
                  : '自动时用渠道默认模型'
              }
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">渠道默认</SelectItem>
            {enabledModels.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name || m.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            协调者（不 @ 时默认由该成员应答）
          </span>
          <Switch size="sm" checked={isCoordinator} onCheckedChange={setIsCoordinator} />
        </div>

        <label className="mt-3 block text-xs text-muted-foreground" htmlFor="collab-add-member-role">
          角色（可选）
        </label>
        <Select
          value={roleMode === 'library' ? selectedRoleId : roleMode}
          onValueChange={(v) => {
            if (v === 'none' || v === 'custom') {
              setRoleMode(v)
              setSelectedRoleId('')
            } else {
              setRoleMode('library')
              setSelectedRoleId(v)
            }
          }}
        >
          <SelectTrigger id="collab-add-member-role" className="mt-1">
            <SelectValue placeholder="无角色" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">无角色</SelectItem>
            {roles.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.displayName}（{r.id}）
              </SelectItem>
            ))}
            <SelectItem value="custom">自定义角色 prompt…</SelectItem>
          </SelectContent>
        </Select>
        {roleMode === 'library' && selectedRole ? (
          <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">{selectedRole.description}</p>
        ) : null}
        {roleMode === 'custom' ? (
          <Textarea
            className="mt-1.5 resize-none"
            rows={3}
            placeholder="输入该成员的角色设定 / 专业能力 prompt"
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
          />
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!displayName.trim() && !(roleMode === 'library' && selectedRole)}
            onClick={submit}
          >
            添加
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
