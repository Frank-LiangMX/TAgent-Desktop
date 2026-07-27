import { useEffect, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  Settings,
  Palette,
  Cable,
  Folder,
  Info,
  X,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsSegmentedControl,
  Switch,
} from '@tagent/ui'
import {
  themeModeAtom,
  themeStyleAtom,
  setThemeMode,
  setThemeStyle,
  type ThemeMode,
  type ThemeStyle,
} from '../../atoms/theme'
import {
  dynamicBgEnabledAtom,
} from '../../atoms/dynamic-bg'
import {
  channelsAtom,
  externalChannelsAtom,
  ksccChannelAtom,
  loadChannelsAtom,
} from '../../atoms/channel-atoms'
import {
  currentWorkspaceAtom,
  workspacesAtom,
} from '../../atoms/workspace-atoms'

const APP_VERSION = '2.0.0-dev.8'

type SettingsTab = 'general' | 'appearance' | 'channels' | 'workspace' | 'about'

interface TabItem {
  id: SettingsTab
  label: string
  description: string
  icon: React.ReactNode
  group: 'core' | 'advanced'
}

const TAB_GROUPS: Array<{ key: TabItem['group']; label: string }> = [
  { key: 'core', label: '核心' },
  { key: 'advanced', label: '高级' },
]

const ALL_TABS: TabItem[] = [
  {
    id: 'general',
    label: '通用',
    description: '外观、主题等基础偏好',
    icon: <Settings size={14} strokeWidth={1.75} />,
    group: 'core',
  },
  {
    id: 'channels',
    label: '渠道',
    description: 'AI 供应商、密钥与连通',
    icon: <Cable size={14} strokeWidth={1.75} />,
    group: 'core',
  },
  {
    id: 'workspace',
    label: '工作区',
    description: '项目目录与存储',
    icon: <Folder size={14} strokeWidth={1.75} />,
    group: 'core',
  },
  {
    id: 'appearance',
    label: '外观',
    description: '主题、色系与材质',
    icon: <Palette size={14} strokeWidth={1.75} />,
    group: 'advanced',
  },
  {
    id: 'about',
    label: '关于',
    description: '版本与环境信息',
    icon: <Info size={14} strokeWidth={1.75} />,
    group: 'advanced',
  },
]

const THEME_COLORS: { value: ThemeStyle; label: string; rgb: string }[] = [
  { value: 'default', label: '默认', rgb: '37 37 37' },
  { value: 'ocean', label: '海洋', rgb: '23 55 94' },
  { value: 'forest', label: '森林', rgb: '20 60 40' },
  { value: 'slate', label: '石板', rgb: '60 60 70' },
  { value: 'orange', label: '暖橙', rgb: '100 55 20' },
  { value: 'purple', label: '紫罗兰', rgb: '70 30 90' },
]

const MODE_OPTIONS = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
]

function renderTabContent(tab: SettingsTab): JSX.Element {
  switch (tab) {
    case 'general': return <GeneralSettings />
    case 'appearance': return <AppearanceSettings />
    case 'channels': return <ChannelsSettings />
    case 'workspace': return <WorkspaceSettings />
    case 'about': return <AboutSettings />
    default: return <GeneralSettings />
  }
}

function SettingsPageIntro({ title, description }: { title: string; description?: string }): JSX.Element {
  return (
    <div className="settings-page-intro">
      <div>
        <h2 className="settings-page-intro-title">{title}</h2>
        {description && <p className="settings-page-intro-desc">{description}</p>}
      </div>
    </div>
  )
}

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): JSX.Element {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')
  const [paneKey, setPaneKey] = useState(0)

  const handleTabChange = (tabId: SettingsTab): void => {
    if (tabId === activeTab) return
    setActiveTab(tabId)
    setPaneKey((k) => k + 1)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideClose
        className="!fixed !inset-0 !z-[100] !m-auto !grid !h-min !w-min !max-w-[unset] !translate-x-0 !translate-y-0 !transform-none !gap-0 !border-0 !bg-transparent !p-0 !shadow-none !duration-0 !opacity-100"
      >
        <div className="settings-dialog-shell">
          <div className="settings-shell">
            {/* 顶栏 */}
            <header className="settings-shell-topbar">
              <div className="settings-shell-topbar-brand">
                <span className="settings-shell-topbar-mark" aria-hidden>T</span>
                <div className="settings-shell-topbar-copy">
                  <span className="settings-shell-kicker">PREFERENCES</span>
                  <span className="settings-shell-title">设置</span>
                </div>
              </div>
              <div className="settings-shell-topbar-actions">
                <button
                  type="button"
                  onClick={() => onOpenChange(false)}
                  className="settings-shell-close"
                  aria-label="关闭设置"
                >
                  <X size={14} strokeWidth={2} />
                </button>
              </div>
            </header>

            {/* Body */}
            <div className="settings-shell-body">
              <aside className="settings-shell-nav">
                <nav className="settings-shell-nav-scroll" aria-label="设置分类">
                  {TAB_GROUPS.map((group) => {
                    const groupTabs = ALL_TABS.filter((t) => t.group === group.key)
                    if (groupTabs.length === 0) return null
                    return (
                      <div key={group.key} className="settings-shell-group">
                        <div className="settings-shell-group-label">{group.label}</div>
                        {groupTabs.map((tab) => (
                          <button
                            key={tab.id}
                            type="button"
                            data-active={activeTab === tab.id || undefined}
                            onClick={() => handleTabChange(tab.id)}
                            className="settings-shell-nav-item"
                          >
                            <span className="settings-shell-nav-item-icon">{tab.icon}</span>
                            <span className="settings-shell-nav-item-label">{tab.label}</span>
                          </button>
                        ))}
                      </div>
                    )
                  })}
                </nav>
              </aside>

              <section className="settings-shell-main">
                <div className="settings-shell-scroll">
                  <div key={`${activeTab}-${paneKey}`} className="settings-shell-content settings-shell-pane">
                    {renderTabContent(activeTab)}
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* ===== Tab 内容组件 ===== */

function GeneralSettings(): JSX.Element {
  const themeMode = useAtomValue(themeModeAtom)
  const themeStyle = useAtomValue(themeStyleAtom)
  const dynamicBg = useAtomValue(dynamicBgEnabledAtom)
  const setDynamicBg = useSetAtom(dynamicBgEnabledAtom)

  return (
    <div className="settings-page">
      <SettingsPageIntro title="通用" description="界面外观与基础偏好" />

      <SettingsSection title="显示设定">
        <SettingsCard>
          <SettingsSegmentedControl
            label="外观模式"
            description="选择浅色、深色或跟随系统主题"
            value={themeMode}
            onValueChange={(v) => setThemeMode(v as ThemeMode, themeStyle)}
            options={MODE_OPTIONS}
          />
        </SettingsCard>
        <SettingsCard divided={false}>
          <div className="px-3 pt-2.5 pb-0.5">
            <span className="settings-field-label text-xs text-muted-foreground">主题色</span>
          </div>
          <div className="theme-swatch-grid">
            {THEME_COLORS.map(({ value, label, rgb }) => (
              <button
                key={value}
                type="button"
                className={`theme-swatch-btn ${themeStyle === value ? 'theme-swatch-btn--active' : ''}`}
                onClick={() => setThemeStyle(value as ThemeStyle, themeMode)}
              >
                <div className="theme-swatch-dot" style={{ background: `rgb(${rgb})` }} />
                <span className="theme-swatch-label">{label}</span>
              </button>
            ))}
          </div>
        </SettingsCard>
        <SettingsCard divided={false}>
          <div className="settings-row">
            <div className="settings-row-main min-w-0 flex-1">
              <span className="settings-field-label">动态背景</span>
              <div className="settings-row-bottom mt-1">
                <span className="text-xs leading-relaxed text-muted-foreground">渐变光晕缓慢流动，透过侧栏与面板可见</span>
              </div>
            </div>
            <div className="settings-row-control shrink-0">
              <Switch
                checked={dynamicBg}
                onCheckedChange={(v) => {
                  setDynamicBg(v)
                  try { localStorage.setItem('tagent-dynamic-bg', v ? 'true' : 'false') } catch {}
                }}
              />
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}

function AppearanceSettings(): JSX.Element {
  const themeMode = useAtomValue(themeModeAtom)
  const themeStyle = useAtomValue(themeStyleAtom)
  const dynamicBg = useAtomValue(dynamicBgEnabledAtom)
  const setDynamicBg = useSetAtom(dynamicBgEnabledAtom)

  return (
    <div className="settings-page">
      <SettingsPageIntro title="外观" description="主题色系与材质风格" />

      <SettingsSection title="主题">
        <SettingsCard>
          <SettingsSegmentedControl
            label="外观模式"
            description="选择浅色、深色或跟随系统主题"
            value={themeMode}
            onValueChange={(v) => setThemeMode(v as ThemeMode, themeStyle)}
            options={MODE_OPTIONS}
          />
        </SettingsCard>
        <SettingsCard divided={false}>
          <div className="px-3 pt-2.5 pb-0.5">
            <span className="settings-field-label text-xs text-muted-foreground">主题色</span>
          </div>
          <div className="theme-swatch-grid">
            {THEME_COLORS.map(({ value, label, rgb }) => (
              <button
                key={value}
                type="button"
                className={`theme-swatch-btn ${themeStyle === value ? 'theme-swatch-btn--active' : ''}`}
                onClick={() => setThemeStyle(value as ThemeStyle, themeMode)}
              >
                <div className="theme-swatch-dot" style={{ background: `rgb(${rgb})` }} />
                <span className="theme-swatch-label">{label}</span>
              </button>
            ))}
          </div>
        </SettingsCard>
        <SettingsCard divided={false}>
          <div className="settings-row">
            <div className="settings-row-main min-w-0 flex-1">
              <span className="settings-field-label">动态背景</span>
              <div className="settings-row-bottom mt-1">
                <span className="text-xs leading-relaxed text-muted-foreground">渐变光晕缓慢流动，透过侧栏与面板可见</span>
              </div>
            </div>
            <div className="settings-row-control shrink-0">
              <Switch
                checked={dynamicBg}
                onCheckedChange={(v) => {
                  setDynamicBg(v)
                  try { localStorage.setItem('tagent-dynamic-bg', v ? 'true' : 'false') } catch {}
                }}
              />
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}

function ChannelsSettings(): JSX.Element {
  const channels = useAtomValue(channelsAtom)
  const kscc = useAtomValue(ksccChannelAtom)
  const externals = useAtomValue(externalChannelsAtom)
  const loadChannels = useSetAtom(loadChannelsAtom)

  useEffect(() => {
    void loadChannels()
  }, [loadChannels])

  return (
    <div className="settings-page">
      <SettingsPageIntro
        title="渠道"
        description={`${channels.length} 个 AI 供应商配置`}
      />

      <SettingsSection title="已配置渠道">
        <SettingsCard>
          {kscc && (
            <ChannelSummaryRow
              name={kscc.name}
              provider="kscc 内网"
              enabled={kscc.enabled}
              builtin
            />
          )}
          {externals.length === 0 && !kscc && (
            <div className="settings-row text-xs text-muted-foreground">暂无渠道</div>
          )}
          {externals.map((ch) => (
            <ChannelSummaryRow
              key={ch.id}
              name={ch.name}
              provider={ch.provider}
              enabled={ch.enabled}
            />
          ))}
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}

function WorkspaceSettings(): JSX.Element {
  const workspace = useAtomValue(currentWorkspaceAtom)
  const workspaces = useAtomValue(workspacesAtom)

  return (
    <div className="settings-page">
      <SettingsPageIntro
        title="工作区"
        description={workspaces.length > 0 ? `${workspaces.length} 个工作区` : '尚未创建工作区'}
      />

      <SettingsSection title="当前工作区">
        <SettingsCard>
          {workspace ? (
            <SettingsRow label={workspace.name ?? workspace.id}>
              <span className="text-xs text-muted-foreground">{workspace.id}</span>
            </SettingsRow>
          ) : (
            <SettingsRow label="无选中工作区" />
          )}
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}

function AboutSettings(): JSX.Element {
  return (
    <div className="settings-page">
      <SettingsPageIntro title="关于" />

      <SettingsSection title="TAgent-Desktop">
        <SettingsCard divided={false}>
          <div className="settings-about">
            <div className="settings-about-name">TAgent-Desktop</div>
            <div className="settings-about-version">v{APP_VERSION}</div>
            <p className="settings-about-desc">
              双核架构（kscc + Pi）的 AI 编程助手桌面端。
              会话 = 进程常驻，双核可拔插。
            </p>
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}

function ChannelSummaryRow({
  name,
  provider,
  enabled,
  builtin = false,
}: {
  name: string
  provider: string
  enabled: boolean
  builtin?: boolean
}): JSX.Element {
  return (
    <div className="channel-summary-item">
      <div className={`channel-summary-dot ${enabled ? 'channel-summary-dot--on' : 'channel-summary-dot--off'}`} />
      <span className="channel-summary-name">{name}</span>
      <span className="channel-summary-provider">
        {builtin ? `${provider} · 内置` : provider}
      </span>
    </div>
  )
}
