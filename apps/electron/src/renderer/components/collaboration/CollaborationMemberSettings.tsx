/**
 * 协作室成员设置弹层：改显示名、渠道、模型。
 */
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@tagent/ui'
import type { Channel, CollaborationMember } from '@tagent/shared'

export interface CollaborationMemberSettingsProps {
  open: boolean
  member: CollaborationMember | null
  channels: Channel[]
  onCancel: () => void
  onSave: (patch: { displayName: string; channelId: string; modelId: string }) => void
}

export function CollaborationMemberSettings({
  open,
  member,
  channels,
  onCancel,
  onSave,
}: CollaborationMemberSettingsProps): JSX.Element | null {
  const [displayName, setDisplayName] = useState('')
  const [channelId, setChannelId] = useState('')
  const [modelId, setModelId] = useState('')

  useEffect(() => {
    if (!open || !member) return
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

  if (!open || !member) return null

  const submit = (): void => {
    const name = displayName.trim()
    if (!name) return
    onSave({ displayName: name, channelId, modelId })
  }

  return (
    <div
      className="absolute inset-0 z-[80] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="collab-member-settings-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="w-full max-w-sm rounded-xl border border-border bg-background p-4 shadow-xl">
        <h2 id="collab-member-settings-title" className="text-sm font-semibold text-foreground">
          成员设置
          {member.isCoordinator ? (
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">协调者</span>
          ) : null}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">改渠道或模型后，下一次 turn 生效。</p>

        <label className="mt-3 block text-xs text-muted-foreground" htmlFor="collab-member-name">
          显示名
        </label>
        <input
          id="collab-member-name"
          className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onCancel()
            }
          }}
        />

        <label className="mt-3 block text-xs text-muted-foreground" htmlFor="collab-member-channel">
          渠道
        </label>
        <select
          id="collab-member-channel"
          className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={channelId}
          onChange={(e) => {
            setChannelId(e.target.value)
            setModelId('')
          }}
        >
          <option value="">未绑定</option>
          {enabledChannels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        <label className="mt-3 block text-xs text-muted-foreground" htmlFor="collab-member-model">
          模型
        </label>
        <select
          id="collab-member-model"
          className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          value={modelId}
          disabled={!channelId || enabledModels.length === 0}
          onChange={(e) => setModelId(e.target.value)}
        >
          <option value="">{channelId ? '渠道默认' : '先选渠道'}</option>
          {enabledModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name || m.id}
            </option>
          ))}
        </select>

        {enabledChannels.length === 0 ? (
          <p className="mt-2 text-xs text-amber-600">没有已启用的渠道。请先去设置 → 渠道启用。</p>
        ) : null}
        {(member.mentionAliases?.length ?? 0) > 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            旧名仍可 @：{(member.mentionAliases ?? []).join('、')}
          </p>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button type="button" size="sm" disabled={!displayName.trim()} onClick={submit}>
            保存
          </Button>
        </div>
      </div>
    </div>
  )
}
