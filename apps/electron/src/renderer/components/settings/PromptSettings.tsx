/**
 * PromptSettings — 系统提示词管理（设置 · 提示词）
 *
 * 列表选择 / 新建 / 删除 / 设为默认；编辑区防抖保存；内置只读。
 * 落盘 ~/.tagent[-dev]/system-prompts.json；Chat 模式主会话会注入默认提示词。
 */
import { useAtom, useAtomValue } from 'jotai'
import { Plus, Trash2, Star } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SystemPrompt, SystemPromptCreateInput, SystemPromptUpdateInput } from '@tagent/shared'
import {
  AppTooltip,
  Button,
  SettingsCard,
  SettingsInput,
  SettingsPageIntro,
  SettingsSection,
  SettingsToggle,
  Textarea,
} from '@tagent/ui'
import { cn } from '../../lib/utils'
import {
  defaultPromptIdAtom,
  promptConfigAtom,
  selectedPromptIdAtom,
} from '../../atoms/system-prompt-atoms'

const DEBOUNCE_MS = 500

export function PromptSettings(): JSX.Element {
  const [config, setConfig] = useAtom(promptConfigAtom)
  const [selectedId, setSelectedId] = useAtom(selectedPromptIdAtom)
  const defaultPromptId = useAtomValue(defaultPromptIdAtom)

  const [editName, setEditName] = useState('')
  const [editContent, setEditContent] = useState('')
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const selectedPrompt = useMemo(
    () => config.prompts.find((p) => p.id === selectedId),
    [config.prompts, selectedId],
  )

  useEffect(() => {
    void window.electronAPI
      .getSystemPromptConfig()
      .then((cfg) => {
        setConfig(cfg)
        setError('')
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : '无法加载提示词')
      })
  }, [setConfig])

  useEffect(() => {
    if (!selectedPrompt) {
      // 选中项被删或不存在 → 回退默认
      if (config.prompts.length > 0) {
        setSelectedId(config.defaultPromptId ?? config.prompts[0]!.id)
      }
      return
    }
    setEditName(selectedPrompt.name)
    setEditContent(selectedPrompt.content)
  }, [selectedPrompt, config.defaultPromptId, config.prompts, setSelectedId])

  const debounceSave = useCallback(
    (id: string, input: SystemPromptUpdateInput): void => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        void window.electronAPI
          .updateSystemPrompt(id, input)
          .then((updated) => {
            setConfig((prev) => ({
              ...prev,
              prompts: prev.prompts.map((p) => (p.id === updated.id ? updated : p)),
            }))
            setError('')
          })
          .catch((e) => {
            setError(e instanceof Error ? e.message : '保存失败')
          })
      }, DEBOUNCE_MS)
    },
    [setConfig],
  )

  const handleCreate = async (): Promise<void> => {
    const input: SystemPromptCreateInput = { name: '新提示词', content: '' }
    try {
      const created = await window.electronAPI.createSystemPrompt(input)
      setConfig((prev) => ({ ...prev, prompts: [...prev.prompts, created] }))
      setSelectedId(created.id)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败')
    }
  }

  const handleDelete = async (id: string): Promise<void> => {
    try {
      await window.electronAPI.deleteSystemPrompt(id)
      setConfig((prev) => {
        const prompts = prev.prompts.filter((p) => p.id !== id)
        const defaultPromptIdNext =
          prev.defaultPromptId === id ? 'builtin-default' : prev.defaultPromptId
        return { ...prev, prompts, defaultPromptId: defaultPromptIdNext }
      })
      if (selectedId === id) setSelectedId('builtin-default')
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败')
    }
  }

  const handleSetDefault = async (id: string): Promise<void> => {
    try {
      await window.electronAPI.setDefaultPrompt(id)
      setConfig((prev) => ({ ...prev, defaultPromptId: id }))
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : '设置默认失败')
    }
  }

  const handleNameChange = (value: string): void => {
    setEditName(value)
    if (selectedPrompt && !selectedPrompt.isBuiltin) {
      debounceSave(selectedPrompt.id, { name: value })
    }
  }

  const handleContentChange = (value: string): void => {
    setEditContent(value)
    if (selectedPrompt && !selectedPrompt.isBuiltin) {
      debounceSave(selectedPrompt.id, { content: value })
    }
  }

  const handleAppendChange = async (enabled: boolean): Promise<void> => {
    try {
      await window.electronAPI.updateAppendSetting(enabled)
      setConfig((prev) => ({ ...prev, appendDateTimeAndUserName: enabled }))
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : '更新追加设置失败')
    }
  }

  return (
    <div className="settings-page">
      <SettingsPageIntro
        title="提示词"
        description="Chat 模式系统提示词模板；默认项会在 Chat 会话注入。内置不可改，可自建副本。"
      />

      {error ? (
        <p className="mb-3 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <SettingsSection
        title="系统提示词"
        description="选择、新建或设为默认"
        action={
          <Button size="sm" variant="outline" onClick={() => void handleCreate()}>
            <Plus className="mr-1 size-3.5" />
            新建
          </Button>
        }
      >
        <SettingsCard divided={false} className="p-1.5">
          <div className="flex flex-col gap-0.5">
            {config.prompts.map((prompt) => (
              <PromptListItem
                key={prompt.id}
                prompt={prompt}
                isSelected={prompt.id === selectedId}
                isDefault={prompt.id === defaultPromptId}
                isHovered={prompt.id === hoveredId}
                onSelect={setSelectedId}
                onDelete={(id) => void handleDelete(id)}
                onSetDefault={(id) => void handleSetDefault(id)}
                onHoverChange={setHoveredId}
              />
            ))}
          </div>
        </SettingsCard>
      </SettingsSection>

      {selectedPrompt ? (
        <SettingsSection title="提示词内容">
          <SettingsCard divided={false} className="space-y-3 p-4">
            <SettingsInput
              label="名称"
              value={editName}
              onChange={handleNameChange}
              disabled={selectedPrompt.isBuiltin}
            />
            <div>
              <label className="mb-1.5 block text-sm font-medium text-foreground">内容</label>
              <Textarea
                value={editContent}
                onChange={(e) => handleContentChange(e.target.value)}
                readOnly={selectedPrompt.isBuiltin}
                className={cn(
                  'min-h-[280px] resize-y',
                  selectedPrompt.isBuiltin && 'cursor-not-allowed opacity-60',
                )}
                placeholder="输入系统提示词内容…"
              />
              {selectedPrompt.isBuiltin ? (
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  内置提示词只读；点「新建」后可基于空白模板自写，或复制内容到自定义项。
                </p>
              ) : null}
            </div>
          </SettingsCard>
        </SettingsSection>
      ) : null}

      <SettingsSection title="增强选项">
        <SettingsCard>
          <SettingsToggle
            label="追加日期时间和用户名"
            description="在提示词末尾自动追加当前日期时间和用户名"
            checked={config.appendDateTimeAndUserName}
            onCheckedChange={(v) => void handleAppendChange(v)}
          />
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}

interface PromptListItemProps {
  prompt: SystemPrompt
  isSelected: boolean
  isDefault: boolean
  isHovered: boolean
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onSetDefault: (id: string) => void
  onHoverChange: (id: string | null) => void
}

function PromptListItem({
  prompt,
  isSelected,
  isDefault,
  isHovered,
  onSelect,
  onDelete,
  onSetDefault,
  onHoverChange,
}: PromptListItemProps): JSX.Element {
  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        'flex cursor-pointer items-center gap-2 rounded-xl border border-transparent px-3 py-2.5 transition-colors',
        isSelected
          ? 'border-primary/25 bg-primary/8'
          : 'hover:border-border/60 hover:bg-foreground/[0.03]',
      )}
      onClick={() => onSelect(prompt.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(prompt.id)
        }
      }}
      onMouseEnter={() => onHoverChange(prompt.id)}
      onMouseLeave={() => onHoverChange(null)}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="truncate text-sm font-medium">{prompt.name}</span>
        {prompt.isBuiltin ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">(内置)</span>
        ) : null}
        {isDefault ? (
          <Star className="size-3.5 shrink-0 fill-amber-500 text-amber-500" aria-label="默认" />
        ) : null}
      </div>
      <div
        className={cn(
          'flex shrink-0 items-center gap-0.5 transition-opacity',
          isHovered ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      >
        {!isDefault ? (
          <AppTooltip label="设为默认">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-7"
              onClick={(e) => {
                e.stopPropagation()
                onSetDefault(prompt.id)
              }}
              aria-label="设为默认"
            >
              <Star className="size-3.5 text-muted-foreground" />
            </Button>
          </AppTooltip>
        ) : null}
        {!prompt.isBuiltin ? (
          <AppTooltip label="删除">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-7 text-muted-foreground hover:text-destructive"
              onClick={(e) => {
                e.stopPropagation()
                onDelete(prompt.id)
              }}
              aria-label="删除"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </AppTooltip>
        ) : null}
      </div>
    </div>
  )
}
