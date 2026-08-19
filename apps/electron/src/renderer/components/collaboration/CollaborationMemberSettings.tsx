/**
 * 协作室成员设置弹出面板（锚定成员气泡，对齐模型选择器形态，不做全局弹窗）。
 *
 * 触发 = 页面传入的成员气泡（children）；面板内可改显示名、渠道、模型。
 * 表单控件用 @tagent/ui 主题化组件（Input / Select）。
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
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
} from '@tagent/ui'
import type { Channel, CollaborationMember } from '@tagent/shared'

export interface CollaborationMemberSettingsProps {
  member: CollaborationMember
  channels: Channel[]
  /** 触发元素（成员气泡按钮） */
  children: ReactNode
  onSave: (patch: {
    memberId: string
    displayName: string
    channelId: string
    modelId: string
  }) => void
}

export function CollaborationMemberSettings({
  member,
  channels,
  children,
  onSave,
}: CollaborationMemberSettingsProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [displayName, setDisplayName] = useState('')
  const [channelId, setChannelId] = useState('')
  const [modelId, setModelId] = useState('')

  // 每次打开回填当前成员配置
  useEffect(() => {
    if (!open) return
    setDisplayName(member.displayName)
    setChannelId(member.channelId ?? '')
    setModelId(member.modelId ?? '')
  }, [open, member])

  const enabledChannels = useMemo(
    () => channels.filter((c) => c.enabled),
    [channels],
  )
  const selectedChannel = enabledChannels.find((c) => c.id === channelId)
  const enabledModels = selectedChannel?.models.filter((m) => m.enabled) ?? []

  const submit = (): void => {
    const name = displayName.trim()
    if (!name) return
    onSave({ memberId: member.id, displayName: name, channelId, modelId })
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="end" side="bottom" sideOffset={6} className="w-80">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-foreground">
            成员设置
            {member.isCoordinator ? (
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">协调者</span>
            ) : null}
          </h2>
          <span className="text-[11px] text-muted-foreground">改渠道/模型后下一次 turn 生效</span>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          后端：
          {channels.find((c) => c.id === member.channelId)?.name ?? '未绑定'}
          {member.roleSnapshot.roleId
            ? ` · 角色：${member.roleSnapshot.displayName}`
            : ''}
        </p>

        <label className="mt-3 block text-xs text-muted-foreground" htmlFor="collab-member-name">
          显示名
        </label>
        <Input
          id="collab-member-name"
          className="mt-1"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setOpen(false)
            }
          }}
        />

        <label className="mt-3 block text-xs text-muted-foreground" htmlFor="collab-member-channel">
          渠道
        </label>
        <Select
          value={channelId || 'none'}
          onValueChange={(v) => {
            setChannelId(v === 'none' ? '' : v)
            setModelId('')
          }}
        >
          <SelectTrigger id="collab-member-channel" className="mt-1">
            <SelectValue placeholder="未绑定" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">未绑定</SelectItem>
            {enabledChannels.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <label className="mt-3 block text-xs text-muted-foreground" htmlFor="collab-member-model">
          模型
        </label>
        <Select
          value={modelId || 'default'}
          onValueChange={(v) => setModelId(v === 'default' ? '' : v)}
          disabled={!channelId || enabledModels.length === 0}
        >
          <SelectTrigger id="collab-member-model" className="mt-1">
            <SelectValue placeholder={channelId ? '渠道默认' : '先选渠道'} />
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

        {enabledChannels.length === 0 ? (
          <p className="mt-2 text-xs text-amber-600">没有已启用的渠道。请先去设置 → 渠道启用。</p>
        ) : null}
        {(member.mentionAliases?.length ?? 0) > 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            旧名仍可 @：{(member.mentionAliases ?? []).join('、')}
          </p>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button type="button" size="sm" disabled={!displayName.trim()} onClick={submit}>
            保存
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
