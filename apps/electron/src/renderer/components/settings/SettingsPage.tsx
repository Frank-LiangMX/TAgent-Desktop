import { useCallback, useEffect, useState, type KeyboardEvent } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  Palette,
  Cable,
  Info,
  X,
  BrainCircuit,
  Boxes,
  Layers,
  Cpu,
  Monitor,
  Moon,
  Sun,
  UserRound,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import {
  Dialog,
  DialogContent,
  SettingsInput,
  SettingsSection,
  SettingsCard,
  Switch,
} from '@tagent/ui'
import {
  themeModeAtom,
  themeStyleAtom,
  resolvedDarkAtom,
  setThemeMode,
  setThemeStyle,
  type ThemeStyle,
} from '../../atoms/theme'
import {
  dynamicBgEnabledAtom,
} from '../../atoms/dynamic-bg'
import {
  userProfileAtom,
  saveUserProfileAtom,
} from '../../atoms/user-profile'
import {
  notificationPrefsAtom,
  setNotificationPrefsAtom,
} from '../../atoms/notification-prefs'
import { splitDockModeAtom } from '../../atoms/feature-flags'
import { ChannelsSettings } from './ChannelsSettings'
import { UpdateChecker } from './UpdateChecker'
import appiconLight from '../../assets/tagent-appicon-light.png'
import appiconDark from '../../assets/tagent-appicon-dark.png'

const APP_VERSION =
  typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : '2.0.0-dev.9'

/** 设置页 tab：工作区在侧栏管；插件/MCP 在 Rail 插件页 */
export type SettingsTab = 'general' | 'appearance' | 'channels' | 'about'

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
    description: '称呼、语言与偏好',
    icon: <UserRound size={14} strokeWidth={1.75} />,
    group: 'core',
  },
  {
    id: 'appearance',
    label: '外观',
    description: '外观模式、主题色与动态背景',
    icon: <Palette size={14} strokeWidth={1.75} />,
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
    id: 'about',
    label: '关于',
    description: '版本与环境信息',
    icon: <Info size={14} strokeWidth={1.75} />,
    group: 'advanced',
  },
]

/** 预览装饰符号（对齐 TAgent_General 风格库） */
type DecoKind =
  | 'cloud'
  | 'wave'
  | 'leaf'
  | 'star'
  | 'moon'
  | 'gem'
  | 'sun'
  | 'flame'
  | 'flower'
  | 'orb'

interface StyleCardDef {
  family: ThemeStyle
  variant: 'light' | 'dark'
  name: string
  tag: string
  previewClass: string
  deco: DecoKind
}

/**
 * 命名对齐 TAgent_General scene 配色气质。
 * 浅/深各一套，按当前 resolvedDark 只显示对应变体。
 */
const STYLE_CARDS: readonly StyleCardDef[] = [
  { family: 'default', name: '中性', tag: 'Neutral', variant: 'light', previewClass: 'tagent-theme-default-light', deco: 'orb' },
  { family: 'slate', name: '暖砂', tag: 'Slate', variant: 'light', previewClass: 'tagent-theme-cloud-dancer', deco: 'cloud' },
  { family: 'ocean', name: '碧海', tag: 'Ocean', variant: 'light', previewClass: 'tagent-theme-ocean-light', deco: 'wave' },
  { family: 'forest', name: '翠林', tag: 'Forest', variant: 'light', previewClass: 'tagent-theme-forest-light', deco: 'leaf' },
  { family: 'orange', name: '琥珀', tag: 'Amber', variant: 'light', previewClass: 'tagent-theme-terracotta-dawn', deco: 'sun' },
  { family: 'purple', name: '紫藤', tag: 'Violet', variant: 'light', previewClass: 'tagent-theme-wisteria-dawn', deco: 'flower' },
  { family: 'default', name: '中性', tag: 'Neutral', variant: 'dark', previewClass: 'tagent-theme-default-dark', deco: 'orb' },
  { family: 'slate', name: '暖砂', tag: 'Slate', variant: 'dark', previewClass: 'tagent-theme-morandi-night', deco: 'gem' },
  { family: 'ocean', name: '碧海', tag: 'Ocean', variant: 'dark', previewClass: 'tagent-theme-ocean-dark', deco: 'star' },
  { family: 'forest', name: '翠林', tag: 'Forest', variant: 'dark', previewClass: 'tagent-theme-forest-dark', deco: 'moon' },
  { family: 'orange', name: '琥珀', tag: 'Amber', variant: 'dark', previewClass: 'tagent-theme-terracotta-night', deco: 'flame' },
  { family: 'purple', name: '紫藤', tag: 'Violet', variant: 'dark', previewClass: 'tagent-theme-wisteria-night', deco: 'orb' },
]

const DECO_PATHS: Record<DecoKind, JSX.Element> = {
  cloud: (
    <path
      d="M10 28 Q4 28 4 22 Q4 16 10 16 Q11 8 20 8 Q28 8 30 16 Q38 16 38 22 Q38 28 32 28 Z"
      fill="currentColor"
    />
  ),
  wave: (
    <path
      d="M4 22 Q12 14 20 22 T36 22 M4 30 Q12 22 20 30 T36 30"
      stroke="currentColor"
      strokeWidth="3"
      fill="none"
      strokeLinecap="round"
    />
  ),
  leaf: (
    <path
      d="M20 6 C30 10 34 22 30 32 C20 30 12 22 14 12 C16 8 18 6 20 6 Z M16 14 L24 26"
      stroke="currentColor"
      strokeWidth="2"
      fill="currentColor"
      fillOpacity="0.4"
    />
  ),
  star: (
    <g fill="currentColor">
      <circle cx="12" cy="14" r="1.5" />
      <circle cx="28" cy="12" r="1" />
      <circle cx="20" cy="22" r="2" />
      <circle cx="32" cy="26" r="1" />
      <circle cx="10" cy="30" r="1" />
      <circle cx="24" cy="32" r="1.2" />
    </g>
  ),
  moon: <path d="M28 8 A14 14 0 1 0 28 32 A10 10 0 1 1 28 8 Z" fill="currentColor" />,
  gem: (
    <path
      d="M20 6 L32 16 L20 34 L8 16 Z M20 6 L20 34 M8 16 L32 16"
      stroke="currentColor"
      strokeWidth="2"
      fill="currentColor"
      fillOpacity="0.3"
    />
  ),
  sun: (
    <g fill="currentColor">
      <circle cx="20" cy="20" r="6" />
      <g stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <line x1="20" y1="6" x2="20" y2="10" />
        <line x1="20" y1="30" x2="20" y2="34" />
        <line x1="6" y1="20" x2="10" y2="20" />
        <line x1="30" y1="20" x2="34" y2="20" />
        <line x1="10" y1="10" x2="13" y2="13" />
        <line x1="27" y1="27" x2="30" y2="30" />
        <line x1="10" y1="30" x2="13" y2="27" />
        <line x1="27" y1="13" x2="30" y2="10" />
      </g>
    </g>
  ),
  flame: (
    <path
      d="M20 4 C22 10 26 12 27 18 C28 24 25 30 20 32 C15 30 12 24 13 18 C14 14 16 14 17 16 C18 13 17 9 20 4 Z"
      fill="currentColor"
      fillOpacity="0.85"
    />
  ),
  flower: (
    <g fill="currentColor">
      <ellipse cx="20" cy="10" rx="3.5" ry="5.5" />
      <ellipse cx="30" cy="20" rx="5.5" ry="3.5" />
      <ellipse cx="20" cy="30" rx="3.5" ry="5.5" />
      <ellipse cx="10" cy="20" rx="5.5" ry="3.5" />
      <circle cx="20" cy="20" r="2.2" fillOpacity="0.5" />
    </g>
  ),
  orb: (
    <g>
      <circle
        cx="20"
        cy="20"
        r="11"
        stroke="currentColor"
        strokeWidth="1.8"
        fill="none"
        opacity="0.7"
      />
      <circle cx="20" cy="20" r="4" fill="currentColor" />
    </g>
  ),
}

function ThemePreview({ previewClass, deco }: { previewClass: string; deco: DecoKind }): JSX.Element {
  return (
    <div className={cn('tagent-theme-preview', previewClass)}>
      <div className="tagent-theme-deco">
        <svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
          {DECO_PATHS[deco]}
        </svg>
      </div>
    </div>
  )
}

function StyleCard({
  style,
  isSelected,
  onSelect,
}: {
  style: StyleCardDef
  isSelected: boolean
  onSelect: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={isSelected}
      aria-label={`${style.name}（${style.variant === 'light' ? '浅色' : '深色'}）`}
      data-style={`${style.family}-${style.variant}`}
      data-variant={style.variant}
      data-selected={isSelected || undefined}
      className="tagent-style-card"
    >
      <div className="tagent-style-preview-wrap">
        <ThemePreview previewClass={style.previewClass} deco={style.deco} />
        <div className="tagent-style-chrome" aria-hidden="true">
          <span className="tagent-style-chrome-rail" />
          <span className="tagent-style-chrome-panel" />
          <span className="tagent-style-chrome-main" />
        </div>
        {isSelected && (
          <span className="tagent-style-check" aria-hidden="true">
            <svg viewBox="0 0 12 12" width="10" height="10" fill="none">
              <path
                d="M2.5 6.2 5 8.7 9.5 3.5"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        )}
      </div>
      <div className="tagent-style-card-label">
        <span className="tagent-style-card-name">{style.name}</span>
        <span className="tagent-style-card-meta">{style.tag}</span>
      </div>
    </button>
  )
}

function renderTabContent(tab: SettingsTab): JSX.Element {
  switch (tab) {
    case 'general': return <GeneralSettings />
    case 'appearance': return <AppearanceSettings />
    case 'channels': return <ChannelsSettings />
    case 'about': return <AboutSettings />
    default: return <AppearanceSettings />
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
  initialTab = 'appearance',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialTab?: SettingsTab
}): JSX.Element {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab)
  const [paneKey, setPaneKey] = useState(0)

  useEffect(() => {
    if (!open) return
    setActiveTab(initialTab)
    setPaneKey((key) => key + 1)
  }, [initialTab, open])

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
                            aria-current={activeTab === tab.id ? 'page' : undefined}
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
                <div className="settings-shell-scroll scrollbar-thin">
                  <div
                    key={`${activeTab}-${paneKey}`}
                    className={`settings-shell-content settings-shell-pane ${activeTab === 'channels' ? 'settings-shell-content--wide' : ''}`}
                  >
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

/** 深浅切换胶囊（对齐 TAgent_General：日夜图标交叉动画 + 自动） */
function ThemeModeControl({
  isDark,
  isAuto,
  onVariantToggle,
  onAutoToggle,
}: {
  isDark: boolean
  isAuto: boolean
  onVariantToggle: () => void
  onAutoToggle: () => void
}): JSX.Element {
  return (
    <div className="tagent-theme-mode-control">
      <DayNightToggle isDark={isDark} onToggle={onVariantToggle} />
      <button
        type="button"
        aria-pressed={isAuto}
        onClick={onAutoToggle}
        data-active={isAuto || undefined}
        className="tagent-theme-auto"
      >
        <Monitor size={14} strokeWidth={2} aria-hidden="true" />
        <span>自动</span>
      </button>
    </div>
  )
}

function DayNightToggle({
  isDark,
  onToggle,
}: {
  isDark: boolean
  onToggle: () => void
}): JSX.Element {
  // 本地视觉态：先翻图标开启动画，再延后抛主题切换，
  // 避免 html.dark / 风格库重排把 CSS transition 掐掉。
  const [visualDark, setVisualDark] = useState(isDark)

  useEffect(() => {
    setVisualDark(isDark)
  }, [isDark])

  const handleClick = useCallback(() => {
    const next = !visualDark
    setVisualDark(next)
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        onToggle()
      })
    })
  }, [onToggle, visualDark])

  return (
    <button
      type="button"
      role="switch"
      aria-checked={visualDark}
      aria-label={visualDark ? '切换到浅色模式' : '切换到深色模式'}
      onClick={handleClick}
      data-dark={visualDark || undefined}
      className="tagent-daynight-toggle"
    >
      <span className="tagent-daynight-icon tagent-daynight-icon--moon" aria-hidden="true">
        <Moon size={14} strokeWidth={2} fill="currentColor" />
      </span>
      <span className="tagent-daynight-icon tagent-daynight-icon--sun" aria-hidden="true">
        <Sun size={14} strokeWidth={2} />
      </span>
    </button>
  )
}

function GeneralSettings(): JSX.Element {
  const userProfile = useAtomValue(userProfileAtom)
  const saveUserProfile = useSetAtom(saveUserProfileAtom)
  const [nameInput, setNameInput] = useState(userProfile.userName)
  const [error, setError] = useState('')

  // 外部（引导页 / Rail 侧）更新档案后同步输入框
  useEffect(() => {
    setNameInput(userProfile.userName)
  }, [userProfile.userName])

  /** 失焦 / 回车时自动保存；空值恢复原称呼 */
  const handleCommit = useCallback(async (): Promise<void> => {
    const trimmed = nameInput.trim()
    if (!trimmed) {
      setNameInput(userProfile.userName)
      setError('')
      return
    }
    if (trimmed === userProfile.userName) return
    try {
      await saveUserProfile({ userName: trimmed })
      setError('')
    } catch (err) {
      console.error('[通用设置] 更新称呼失败:', err)
      setError('保存失败，请重试')
    }
  }, [nameInput, userProfile.userName, saveUserProfile])

  const notifPrefs = useAtomValue(notificationPrefsAtom)
  const setNotifPrefs = useSetAtom(setNotificationPrefsAtom)
  const splitDockMode = useAtomValue(splitDockModeAtom)
  const setSplitDockMode = useSetAtom(splitDockModeAtom)

  return (
    <div className="settings-page">
      <SettingsPageIntro title="通用" description="称呼与通知偏好" />

      <SettingsSection title="档案">
        <SettingsCard>
          <SettingsInput
            label="我的称呼"
            description="左侧设置入口的头像取首字；输入后自动保存"
            value={nameInput}
            onChange={(v) => {
              setNameInput(v)
              setError('')
            }}
            onBlur={() => void handleCommit()}
            onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
            placeholder="输入你希望被称呼的名字"
            error={error}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="通知">
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          三类通道可独立开关。进度类推荐用顶栏；需要操作时用面板悬浮；离开窗口时用系统通知。
        </p>
        <div className="notif-pref-grid">
          <NotificationPrefCard
            title="顶栏滚动"
            description="窗口标题栏中央滚动提示，不挡主内容"
            checked={notifPrefs.titlebarTicker}
            onCheckedChange={(v) => setNotifPrefs({ titlebarTicker: v })}
            diagram="titlebar"
          />
          <NotificationPrefCard
            title="系统通知"
            description="操作系统气泡；最小化或切走窗口仍能看到"
            checked={notifPrefs.systemDesktop}
            onCheckedChange={(v) => setNotifPrefs({ systemDesktop: v })}
            diagram="system"
          />
          <NotificationPrefCard
            title="面板悬浮"
            description="窗口内 Toast，适合「记住 / 不记」等要点一下的提示"
            checked={notifPrefs.panelToast}
            onCheckedChange={(v) => setNotifPrefs({ panelToast: v })}
            diagram="toast"
          />
        </div>
      </SettingsSection>

      <SettingsSection title="实验功能">
        <SettingsCard>
          <div className="settings-row">
            <div className="settings-row-main min-w-0 flex-1">
              <span className="settings-field-label">分屏工作台</span>
              <div className="settings-row-bottom mt-1">
                <span className="text-xs leading-relaxed text-muted-foreground">
                  拖会话标签到主区边缘自动分屏，多会话同屏独立运行
                </span>
              </div>
            </div>
            <div className="settings-row-control shrink-0">
              <Switch
                checked={splitDockMode}
                onCheckedChange={(v) => setSplitDockMode(v)}
              />
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}

/** 通知偏好卡片：开关 + 几何图示 + HTML 图注（避免 SVG 中文贴边） */
function NotificationPrefCard({
  title,
  description,
  checked,
  onCheckedChange,
  diagram,
}: {
  title: string
  description: string
  checked: boolean
  onCheckedChange: (v: boolean) => void
  diagram: 'titlebar' | 'system' | 'toast'
}): JSX.Element {
  /* 短图注：三列窄卡里长句会贴边换行 */
  const caption =
    diagram === 'titlebar'
      ? checked
        ? '顶栏中央滚动提示'
        : '顶栏不显示状态'
      : diagram === 'system'
        ? checked
          ? '系统角弹出气泡'
          : '不弹系统气泡'
        : checked
          ? '窗口内居中 Toast'
          : '不显示面板 Toast'

  return (
    <SettingsCard
      className={cn('notif-pref-card', !checked && 'notif-pref-card--off')}
      divided={false}
    >
      <div className="notif-pref-card__inner">
        <div className="notif-pref-card__head">
          <div className="min-w-0 flex-1">
            <div className="settings-field-label">{title}</div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
          </div>
          <Switch
            size="sm"
            checked={checked}
            onCheckedChange={onCheckedChange}
            aria-label={title}
          />
        </div>
        <div className="notif-pref-diagram" aria-hidden>
          {diagram === 'titlebar' ? <NotifDiagramTitlebar active={checked} /> : null}
          {diagram === 'system' ? <NotifDiagramSystem active={checked} /> : null}
          {diagram === 'toast' ? <NotifDiagramToast active={checked} /> : null}
          <p className={cn('notif-pref-caption', checked && 'notif-pref-caption--on')}>
            {caption}
          </p>
        </div>
      </div>
    </SettingsCard>
  )
}

/** 纯几何示意：高亮顶栏胶囊，不写 SVG 中文；viewBox 内四周留白 */
function NotifDiagramTitlebar({ active }: { active: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 240 110" className="notif-pref-svg" preserveAspectRatio="xMidYMid meet">
      {/* 窗口：相对 viewBox 四周约 20px 留白 */}
      <rect x="20" y="16" width="200" height="78" rx="10" className="npd-window" />
      <path
        d="M20 26c0-5.5 4.5-10 10-10h180c5.5 0 10 4.5 10 10v10H20V26z"
        className="npd-chrome"
      />
      <rect x="32" y="20" width="14" height="6" rx="2" className="npd-muted" />
      <rect x="188" y="20" width="8" height="6" rx="1.5" className="npd-muted" />
      <rect x="200" y="20" width="8" height="6" rx="1.5" className="npd-muted" />
      {/* 顶栏通知胶囊 */}
      <rect
        x="58"
        y="18"
        width="124"
        height="10"
        rx="5"
        className={active ? 'npd-accent' : 'npd-muted'}
      />
      {active ? (
        <>
          <rect x="66" y="21" width="46" height="4" rx="2" className="npd-accent-bar" />
          <rect x="118" y="21" width="26" height="4" rx="2" className="npd-accent-bar" />
        </>
      ) : null}
      <rect x="32" y="46" width="80" height="36" rx="6" className="npd-panel" />
      <rect x="128" y="46" width="80" height="36" rx="6" className="npd-panel" />
    </svg>
  )
}

function NotifDiagramSystem({ active }: { active: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 240 110" className="notif-pref-svg" preserveAspectRatio="xMidYMid meet">
      <rect x="20" y="16" width="200" height="78" rx="10" className="npd-window" />
      <rect x="32" y="40" width="108" height="40" rx="6" className="npd-panel" />
      {/* 系统气泡：窗口右内侧，不贴窗框 */}
      <rect
        x="148"
        y="28"
        width="60"
        height="38"
        rx="8"
        className={active ? 'npd-accent-fill' : 'npd-muted'}
      />
      {active ? (
        <>
          <rect x="158" y="38" width="34" height="5" rx="2.5" className="npd-accent-bar" />
          <rect x="158" y="48" width="22" height="4" rx="2" className="npd-accent-bar" />
        </>
      ) : null}
    </svg>
  )
}

function NotifDiagramToast({ active }: { active: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 240 110" className="notif-pref-svg" preserveAspectRatio="xMidYMid meet">
      <rect x="20" y="16" width="200" height="78" rx="10" className="npd-window" />
      <rect x="32" y="54" width="176" height="28" rx="6" className="npd-panel" />
      {/* 居中 Toast */}
      <rect
        x="58"
        y="28"
        width="124"
        height="32"
        rx="8"
        className={active ? 'npd-accent-fill' : 'npd-muted'}
      />
      {active ? (
        <>
          <rect x="72" y="38" width="50" height="5" rx="2.5" className="npd-accent-bar" />
          <rect x="130" y="36" width="20" height="10" rx="3" className="npd-btn" />
          <rect x="154" y="36" width="16" height="10" rx="3" className="npd-btn-ghost" />
        </>
      ) : null}
    </svg>
  )
}

function AppearanceSettings(): JSX.Element {
  const themeMode = useAtomValue(themeModeAtom)
  const themeStyle = useAtomValue(themeStyleAtom)
  const resolvedDark = useAtomValue(resolvedDarkAtom)
  const dynamicBg = useAtomValue(dynamicBgEnabledAtom)
  const setDynamicBg = useSetAtom(dynamicBgEnabledAtom)

  const isAuto = themeMode === 'system'

  /** 深浅翻转：退出自动，落到明确 light/dark */
  const handleVariantToggle = useCallback(() => {
    setThemeMode(resolvedDark ? 'light' : 'dark', themeStyle)
  }, [resolvedDark, themeStyle])

  /** 自动：开 → system；关 → 锁定当前解析结果 */
  const handleAutoToggle = useCallback(() => {
    if (isAuto) {
      setThemeMode(resolvedDark ? 'dark' : 'light', themeStyle)
    } else {
      setThemeMode('system', themeStyle)
    }
  }, [isAuto, resolvedDark, themeStyle])

  const visibleCards = STYLE_CARDS.filter(
    (s) => s.variant === (resolvedDark ? 'dark' : 'light'),
  )

  return (
    <div className="settings-page">
      <SettingsPageIntro title="外观" description="外观模式、主题色与动态背景" />

      <SettingsSection title="外观">
        <SettingsCard>
          <div className="settings-row">
            <div className="settings-row-main min-w-0 flex-1">
              <span className="settings-field-label">深浅模式</span>
              <div className="settings-row-bottom mt-1">
                <span className="text-xs leading-relaxed text-muted-foreground">
                  {isAuto
                    ? `自动 · 当前为${resolvedDark ? '深色' : '浅色'}`
                    : `手动 · ${resolvedDark ? '深色' : '浅色'}`}
                </span>
              </div>
            </div>
            <div className="settings-row-control shrink-0">
              <ThemeModeControl
                isDark={resolvedDark}
                isAuto={isAuto}
                onVariantToggle={handleVariantToggle}
                onAutoToggle={handleAutoToggle}
              />
            </div>
          </div>
          <div className="tagent-style-library">
            <div className="tagent-style-group-label">
              <span>主题色系</span>
              <span className="tagent-style-group-hint">
                {resolvedDark ? '深色 · 中暗底 + 透亮光斑' : '浅色 · 冷暖撞色弥散'}
              </span>
            </div>
            <div className="tagent-style-grid" role="listbox" aria-label="主题色系">
              {visibleCards.map((style) => (
                <StyleCard
                  key={`${style.family}-${style.variant}`}
                  style={style}
                  isSelected={themeStyle === style.family}
                  onSelect={() => setThemeStyle(style.family, themeMode)}
                />
              ))}
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-main min-w-0 flex-1">
              <span className="settings-field-label">动态背景</span>
              <div className="settings-row-bottom mt-1">
                <span className="text-xs leading-relaxed text-muted-foreground">
                  渐变光晕缓慢流动，透过侧栏与面板可见
                </span>
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

const ARCH_ITEMS = [
  {
    icon: Layers,
    title: '双核可拔插',
    desc: '内网 kscc 核 + 外部 Pi 核，按渠道选核，对外版可移除 kscc',
  },
  {
    icon: Boxes,
    title: '会话长驻',
    desc: '一个会话一个常驻进程，多轮复用上下文，不重放历史',
  },
  {
    icon: BrainCircuit,
    title: '记忆系统',
    desc: '双核上下文记忆，软重置无感压缩 + 爆上下文兜底续命',
  },
]

/** 运行环境版本（renderer 沙箱无 process，用 typeof 守卫 + UA 解析兜底） */
function getRuntimeVersions(): { electron: string; chrome: string; node: string } {
  if (typeof process !== 'undefined' && process.versions) {
    return {
      electron: process.versions.electron ?? '—',
      chrome: process.versions.chrome ?? '—',
      node: process.versions.node ?? '—',
    }
  }
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  return {
    electron: ua.match(/Electron\/([\d.]+)/)?.[1] ?? '—',
    chrome: ua.match(/Chrome\/([\d.]+)/)?.[1] ?? '—',
    node: '—',
  }
}

const RUNTIME_VERSIONS = getRuntimeVersions()
const PLATFORM =
  typeof navigator !== 'undefined' && navigator.platform ? navigator.platform : '—'

function AboutSettings(): JSX.Element {
  const isDark = useAtomValue(resolvedDarkAtom)
  const appiconSrc = isDark ? appiconDark : appiconLight

  const envItems = [
    { label: 'Electron', value: RUNTIME_VERSIONS.electron },
    { label: 'Chromium', value: RUNTIME_VERSIONS.chrome },
    { label: 'Node.js', value: RUNTIME_VERSIONS.node },
    { label: '平台', value: PLATFORM },
  ]

  return (
    <div className="settings-page settings-about-page">
      <SettingsPageIntro title="关于" description="版本、架构与运行环境" />

      <SettingsCard divided={false} className="settings-about-hero-card">
        <div className="settings-about-hero">
          <div className="settings-about-hero-mark" aria-hidden="true">
            <img
              src={appiconSrc}
              alt=""
              draggable={false}
              className="settings-about-logo"
            />
          </div>
          <div className="settings-about-hero-copy">
            <div className="settings-about-hero-title-row">
              <h3 className="settings-about-name">TAgent-Desktop</h3>
              <span className="settings-about-version">v{APP_VERSION}</span>
            </div>
            <p className="settings-about-desc">
              双核架构（kscc + Pi）的 AI 编程助手桌面端。会话进程常驻，双核可拔插，上下文记忆可续命。
            </p>
            <div className="settings-about-meta">
              <span className="settings-about-meta-item">
                <Cpu size={12} strokeWidth={1.75} aria-hidden="true" />
                kscc · Pi
              </span>
              <span className="settings-about-meta-dot" aria-hidden="true" />
              <span className="settings-about-meta-item">
                <Monitor size={12} strokeWidth={1.75} aria-hidden="true" />
                Desktop
              </span>
            </div>
          </div>
        </div>
      </SettingsCard>

      <SettingsSection title="架构">
        <div className="settings-arch-grid">
          {ARCH_ITEMS.map(({ icon: Icon, title, desc }) => (
            <article key={title} className="settings-arch-card">
              <span className="settings-arch-icon" aria-hidden="true">
                <Icon size={15} strokeWidth={1.75} />
              </span>
              <h4 className="settings-arch-title">{title}</h4>
              <p className="settings-arch-desc">{desc}</p>
            </article>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title="运行环境">
        <SettingsCard divided={false}>
          <div className="settings-env-grid">
            {envItems.map(({ label, value }) => (
              <div key={label} className="settings-env-item">
                <span className="settings-env-label">{label}</span>
                <span className="settings-env-value" title={value}>{value}</span>
              </div>
            ))}
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="软件更新">
        <SettingsCard divided={false}>
          <UpdateChecker />
        </SettingsCard>
      </SettingsSection>

      <footer className="settings-about-footer">
        <span>AGPL-3.0</span>
        <span className="settings-about-footer-sep" aria-hidden="true" />
        <span className="settings-about-footer-repo">Frank-LiangMX/TAgent-Desktop</span>
      </footer>
    </div>
  )
}
