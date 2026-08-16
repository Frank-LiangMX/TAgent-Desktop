/**
 * 协作室添加成员弹窗：显示名 + 内核（渠道）+ 模型 + 是否协调者。
 *
 * 参照 Hermes 的「添加成员 = 选内核 + 模型」模式：
 * - 内核 = 渠道（kscc 内网走 kscc CLI；外部渠道走 Pi HTTP）
 * - 不选渠道时由主进程自动绑定默认渠道（kscc 优先），与建房间行为一致
 * - 模型随渠道联动；选「渠道默认」则不传 modelId
 */
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@tagent/ui'
import type { Channel } from '@tagent/shared'

export interface CollaborationAddMemberDialogProps {
  open: boolean
  channels: Channel[]
  onCancel: () => void
  onSave: (patch: {
    displayName: string
    channelId: string
    modelId: string
    isCoordinator: boolean
  }) => void
}

export function CollaborationAddMemberDialog({
  open,
  channels,
  onCancel,
  onSave,
}: CollaborationAddMemberDialogProps): JSX.Element | null {
  const [displayName, setDisplayName] = useState('')
  const [channelId, setChannelId] = useState('')
  const [modelId, setModelId] = useState('')
  const [isCoordinator, setIsCoordinator] = useState(false)

  // 每次打开重置表单
  useEffect(() => {
    if (!open) return
    setDisplayName('')
    setChannelId('')
    setModelId('')
    setIsCoordinator(false)
  }, [open])

  const enabledChannels = useMemo(
    () => channels.filter((c) => c.enabled),
    [channels],
  )
  const selectedChannel = enabledChannels.find((c) => c.id === channelId)
  const enabledModels = selectedChannel?.models.filter((m) => m.enabled) ?? []

  if (!open) return null

  const submit = (): void => {
    const name = displayName.trim()
    if (!name) return
    onSave({ displayName: name, channelId, modelId, isCoordinator })
  }

  return (
    <div
      className="absolute inset-0 z-[80] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="collab-add-member-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="w-full max-w-sm rounded-xl border border-border bg-background p-4 shadow-xl">
        <h2 id="collab-add-member-title" className="text-sm font-semibold text-foreground">
          添加成员
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          内核即运行渠道；不选时自动绑定默认渠道（kscc 优先）。添加后点击成员气泡可再改。
        </p>

        <label className="mt-3 block text-xs text-muted-foreground" htmlFor="collab-add-member-name">
          显示名
        </label>
        <input
          id="collab-add-member-name"
          className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={displayName}
          placeholder="例如：开发、测试、文档"
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
          autoFocus
        />

        <label className="mt-3 block text-xs text-muted-foreground" htmlFor="collab-add-member-channel">
          内核（渠道）
        </label>
        <select
          id="collab-add-member-channel"
          className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={channelId}
          onChange={(e) => {
            setChannelId(e.target.value)
            setModelId('')
          }}
        >
          <option value="">自动（kscc 优先）</option>
          {enabledChannels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {enabledChannels.length === 0 ? (
          <p className="mt-2 text-xs text-amber-600">没有已启用的渠道，成员将无法回复。请先到设置启用渠道。</p>
        ) : null}

        <label className="mt-3 block text-xs text-muted-foreground" htmlFor="collab-add-member-model">
          模型
        </label>
        <select
          id="collab-add-member-model"
          className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          value={modelId}
          disabled={!channelId || enabledModels.length === 0}
          onChange={(e) => setModelId(e.target.value)}
        >
          <option value="">{channelId ? (enabledModels.length > 0 ? '渠道默认' : '该渠道无可用模型') : '自动时用渠道默认模型'}</option>
          {enabledModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name || m.id}
            </option>
          ))}
        </select>

        <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="size-3.5 rounded border-border accent-primary"
            checked={isCoordinator}
            onChange={(e) => setIsCoordinator(e.target.checked)}
          />
          协调者（消息不 @ 时默认由该成员应答）
        </label>

        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button type="button" size="sm" disabled={!displayName.trim()} onClick={submit}>
            添加
          </Button>
        </div>
      </div>
    </div>
  )
}
