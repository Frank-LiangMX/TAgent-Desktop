/**
 * 插件主页（工作区维度）— Rail 一级入口，对齐 TAgent_General skills
 *
 * 产品单位 = 整合包 Bundle（Cursor/Codex/TAgent_General 风格）。
 * 顶栏：工作区选择 + Segmented（市场 / 已安装 / MCP）。
 * - 市场：整包卡片网格（name/description/category/N MCP + M Skill/安装按钮），点卡片展开详情。
 * - 已安装：来自 plugins-installed.json，可卸载。
 * - MCP：手动配置自定义 MCP 服务器（stdio/http/sse），原独立设置项并入此处。
 * 视觉：复用 ChannelsSettings 的 channel-* 卡片节奏 + @tagent/ui 组件，少量 .plugin-bundle-* CSS。
 */
import { useEffect, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  Download,
  Package,
  Plug,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import {
  Button,
  DestructiveConfirmDialog,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SegmentedTabs,
  SegmentedTabsItem,
} from '@tagent/ui'
import type {
  BuiltinMcpCatalogEntry,
  InstallStoreBundleResult,
  PluginStoreCatalog,
  PluginStoreSkillEntry,
  StorePluginBundle,
  WorkspacePluginBundleRecord,
} from '@tagent/shared'
import { workspacesAtom, loadWorkspacesAtom } from '../../atoms/workspace-atoms'
import { McpSettings } from './McpSettings'

type PluginView = 'market' | 'installed' | 'mcp'
type InstallNotice = { kind: 'success' | 'error'; message: string }

const CATEGORY_LABELS: Record<string, string> = {
  dev: '开发',
  ta: 'TA',
  workflow: '工作流',
  office: '办公',
  planning: '规划',
  meta: '元',
}

const TIER_LABELS: Record<string, string> = {
  recommended: '推荐',
  optional: '可选',
}

function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category
}

function tierLabel(tier: string): string | undefined {
  return TIER_LABELS[tier]
}

function formatDate(iso: string | undefined): string {
  return (iso ?? '').slice(0, 10)
}

export function PluginStoreSettings(): JSX.Element {
  const workspaces = useAtomValue(workspacesAtom)
  const loadWorkspaces = useSetAtom(loadWorkspacesAtom)
  const [selectedId, setSelectedId] = useState('')
  const [catalog, setCatalog] = useState<PluginStoreCatalog | null>(null)
  const [installed, setInstalled] = useState<WorkspacePluginBundleRecord[]>([])
  const [loadingCatalog, setLoadingCatalog] = useState(false)
  const [loadingInstalled, setLoadingInstalled] = useState(false)
  const [view, setView] = useState<PluginView>('market')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [installingId, setInstallingId] = useState<string | null>(null)
  const [installResults, setInstallResults] = useState<Record<string, InstallNotice>>({})
  const [uninstallTarget, setUninstallTarget] = useState<{ bundleId: string; name: string } | null>(null)
  const [uninstalling, setUninstalling] = useState(false)
  const [pageError, setPageError] = useState('')

  // 打开设置时刷新工作区列表（可能在外部新建过项目）
  useEffect(() => {
    void loadWorkspaces()
  }, [loadWorkspaces])

  // 默认选中第一个工作区
  useEffect(() => {
    if (!selectedId && workspaces.length > 0) {
      const first = workspaces[0]
      if (first) setSelectedId(first.id)
    }
  }, [workspaces, selectedId])

  const slug = selectedId

  // 插件目录是全局静态数据，挂载时拉一次
  useEffect(() => {
    let cancelled = false
    setLoadingCatalog(true)
    setPageError('')
    void window.electronAPI
      .getPluginStoreCatalog()
      .then((c) => {
        if (!cancelled) setCatalog(c)
      })
      .catch((err) => {
        if (!cancelled) setPageError(err instanceof Error ? err.message : '无法读取插件目录')
      })
      .finally(() => {
        if (!cancelled) setLoadingCatalog(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const reloadInstalled = async (): Promise<void> => {
    if (!slug) {
      setInstalled([])
      return
    }
    setLoadingInstalled(true)
    try {
      const list = await window.electronAPI.getInstalledPluginBundles(slug)
      setInstalled(list ?? [])
    } catch {
      setInstalled([])
    } finally {
      setLoadingInstalled(false)
    }
  }

  // 切工作区时重载已安装记录，并清掉上一个工作区的安装反馈/展开态
  useEffect(() => {
    setInstallResults({})
    setExpandedId(null)
    void reloadInstalled()
    // reloadInstalled 闭包随 slug 变化，故仅依赖 slug
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug])

  const installedIds = new Set(installed.map((r) => r.bundleId))

  const installBundle = async (bundle: StorePluginBundle): Promise<void> => {
    if (!slug) return
    setInstallingId(bundle.id)
    try {
      const result = await window.electronAPI.installStoreBundle(slug, bundle.id)
      setInstallResults((cur) => ({ ...cur, [bundle.id]: buildInstallNotice(result) }))
      await reloadInstalled()
    } catch (err) {
      setInstallResults((cur) => ({
        ...cur,
        [bundle.id]: { kind: 'error', message: err instanceof Error ? err.message : '安装失败' },
      }))
    } finally {
      setInstallingId(null)
    }
  }

  const doUninstall = async (): Promise<void> => {
    if (!uninstallTarget || !slug) return
    const target = uninstallTarget
    setUninstalling(true)
    try {
      const result = await window.electronAPI.uninstallStoreBundle(slug, target.bundleId)
      if (!result.ok) throw new Error('该整合包未安装，无需卸载')
      await reloadInstalled()
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : '卸载失败')
    } finally {
      setUninstalling(false)
    }
  }

  if (workspaces.length === 0) {
    return (
      <div className="settings-page channel-settings-page">
        <div className="channel-settings-heading">
          <div>
            <h2 className="settings-page-intro-title">插件</h2>
            <p className="settings-page-intro-desc">一键安装整合包：MCP + Skill</p>
          </div>
        </div>
        <div className="channel-empty">
          <Package size={20} />
          <div>
            <strong>尚未打开项目目录</strong>
            <p>请先在主界面打开一个项目目录，再在此安装整合包。</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="settings-page channel-settings-page">
      <div className="channel-settings-heading">
        <div>
          <h2 className="settings-page-intro-title">插件</h2>
          <p className="settings-page-intro-desc">
            整合包一键安装 MCP 与 Skill；高级 MCP 可手动配置服务器
          </p>
        </div>
        {view !== 'mcp' && (
          <Button
            variant="ghost"
            size="sm"
            disabled={loadingCatalog || loadingInstalled}
            onClick={() => {
              void reloadInstalled()
            }}
          >
            <RefreshCw size={14} className={loadingInstalled ? 'animate-spin' : ''} />
            刷新
          </Button>
        )}
      </div>

      <div className="flex items-center gap-2" style={{ marginTop: -6 }}>
        <span className="text-[11px] text-muted-foreground">工作区</span>
        <Select value={selectedId} onValueChange={setSelectedId}>
          <SelectTrigger className="channel-input channel-provider-select" style={{ width: 240 }}>
            <SelectValue placeholder="选择工作区" />
          </SelectTrigger>
          <SelectContent className="scrollbar-thin !z-[130]">
            {workspaces.map((w) => (
              <SelectItem key={w.id} value={w.id}>
                {w.name ?? w.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <SegmentedTabs
        value={view}
        onValueChange={(v) => setView(v as PluginView)}
        className="settings-segmented"
      >
        <SegmentedTabsItem value="market">市场</SegmentedTabsItem>
        <SegmentedTabsItem value="installed">已安装（{installed.length}）</SegmentedTabsItem>
        <SegmentedTabsItem value="mcp">MCP</SegmentedTabsItem>
      </SegmentedTabs>

      {pageError && view !== 'mcp' && (
        <div className="channel-notice channel-notice--error" role="alert">
          <AlertCircle size={15} />
          <span className="channel-notice-copy">{pageError}</span>
        </div>
      )}

      {view === 'market' ? (
        <MarketView
          catalog={catalog}
          loadingCatalog={loadingCatalog}
          installedIds={installedIds}
          expandedId={expandedId}
          onToggleExpand={(id) => setExpandedId(expandedId === id ? null : id)}
          installingId={installingId}
          installResults={installResults}
          canInstall={Boolean(slug)}
          onInstall={installBundle}
        />
      ) : view === 'installed' ? (
        <InstalledView
          installed={installed}
          catalog={catalog}
          loading={loadingInstalled}
          onUninstall={(record, name) => setUninstallTarget({ bundleId: record.bundleId, name })}
        />
      ) : (
        <McpSettings embedded workspaceId={slug} />
      )}

      <DestructiveConfirmDialog
        open={Boolean(uninstallTarget)}
        onOpenChange={(open) => !open && setUninstallTarget(null)}
        icon={<Trash2 size={15} />}
        title={`卸载「${uninstallTarget?.name ?? ''}」？`}
        description="将移除该整合包中未改动的 MCP 与 Skill 目录，并从已安装清单删除。已被你自定义过的 MCP 不会被动。"
        confirmLabel="卸载"
        onConfirm={doUninstall}
      />
    </div>
  )
}

function buildInstallNotice(result: InstallStoreBundleResult): InstallNotice {
  const installedCount = result.installedMcps.length + result.installedSkills.length
  const skippedCount = result.skippedMcps.length + result.skippedSkills.length
  let message = `已安装 ${installedCount} 项`
  if (skippedCount) message += `，跳过 ${skippedCount} 项已存在`
  if (result.errors.length) message += `；${result.errors.length} 项失败：${result.errors.join('；')}`
  const kind = result.errors.length > 0 && installedCount === 0 ? 'error' : 'success'
  return { kind, message }
}

function MarketView({
  catalog,
  loadingCatalog,
  installedIds,
  expandedId,
  onToggleExpand,
  installingId,
  installResults,
  canInstall,
  onInstall,
}: {
  catalog: PluginStoreCatalog | null
  loadingCatalog: boolean
  installedIds: Set<string>
  expandedId: string | null
  onToggleExpand: (id: string) => void
  installingId: string | null
  installResults: Record<string, InstallNotice>
  canInstall: boolean
  onInstall: (bundle: StorePluginBundle) => void
}): JSX.Element {
  if (loadingCatalog && !catalog) {
    return (
      <div className="channel-list-loading">
        <RefreshCw size={16} className="animate-spin" />
        正在读取插件目录…
      </div>
    )
  }
  if (!catalog) return <></>

  const bundles = catalog.bundles
  const mcpByName = new Map(catalog.mcps.map((m) => [m.name, m]))
  const skillBySlug = new Map(catalog.skills.map((s) => [s.slug, s]))

  return (
    <>
      <div className="channel-settings-summary">
        <span>{bundles.length} 个整合包</span>
        <span aria-hidden>·</span>
        <span>选择工作区后一键安装</span>
      </div>
      <div className="plugin-bundle-grid">
        {bundles.map((bundle) => (
          <BundleCard
            key={bundle.id}
            bundle={bundle}
            installed={installedIds.has(bundle.id)}
            expanded={expandedId === bundle.id}
            onToggleExpand={() => onToggleExpand(bundle.id)}
            installing={installingId === bundle.id}
            notice={installResults[bundle.id]}
            canInstall={canInstall}
            onInstall={() => onInstall(bundle)}
            mcpByName={mcpByName}
            skillBySlug={skillBySlug}
          />
        ))}
      </div>
    </>
  )
}

function BundleCard({
  bundle,
  installed,
  expanded,
  onToggleExpand,
  installing,
  notice,
  canInstall,
  onInstall,
  mcpByName,
  skillBySlug,
}: {
  bundle: StorePluginBundle
  installed: boolean
  expanded: boolean
  onToggleExpand: () => void
  installing: boolean
  notice: InstallNotice | undefined
  canInstall: boolean
  onInstall: () => void
  mcpByName: Map<string, BuiltinMcpCatalogEntry>
  skillBySlug: Map<string, PluginStoreSkillEntry>
}): JSX.Element {
  const tier = tierLabel(bundle.tier)
  return (
    <article className="plugin-bundle-card">
      <div className="plugin-bundle-card-head">
        <div className="channel-provider-mark">
          <Package size={15} />
        </div>
        <div className="plugin-bundle-card-identity">
          <div className="plugin-bundle-card-title">
            <strong>{bundle.name}</strong>
            <span className="channel-tag">{categoryLabel(bundle.category)}</span>
            {tier && <span className="channel-tag">{tier}</span>}
            {installed && <span className="channel-tag plugin-bundle-tag-installed">已安装</span>}
          </div>
          <p className="plugin-bundle-card-desc">{bundle.description}</p>
        </div>
      </div>

      <div className="plugin-bundle-card-meta">
        <Plug size={11} />
        <span>{bundle.mcps.length} 个 MCP</span>
        <span aria-hidden>·</span>
        <BookOpen size={11} />
        <span>{bundle.skills.length} 个 Skill</span>
      </div>

      {notice && (
        <div className={`plugin-bundle-notice plugin-bundle-notice--${notice.kind}`} role="status">
          {notice.kind === 'success' ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}
          <span>{notice.message}</span>
        </div>
      )}

      {expanded && (
        <div className="plugin-bundle-details">
          <div className="plugin-bundle-detail-line">
            <strong>MCP</strong>
            <div className="plugin-bundle-chip-list">
              {bundle.mcps.length === 0 ? (
                <span className="plugin-bundle-chip-empty">无</span>
              ) : (
                bundle.mcps.map((name) => (
                  <span className="channel-tag" key={name}>
                    {mcpByName.get(name)?.displayName ?? name}
                  </span>
                ))
              )}
            </div>
          </div>
          <div className="plugin-bundle-detail-line">
            <strong>Skill</strong>
            <div className="plugin-bundle-chip-list">
              {bundle.skills.length === 0 ? (
                <span className="plugin-bundle-chip-empty">无</span>
              ) : (
                bundle.skills.map((s) => (
                  <span className="channel-tag" key={s}>
                    {skillBySlug.get(s)?.name ?? s}
                  </span>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      <div className="plugin-bundle-card-foot">
        <button type="button" className="plugin-bundle-expand" onClick={onToggleExpand}>
          <ChevronDown size={13} className={expanded ? 'plugin-bundle-chevron--open' : ''} />
          {expanded ? '收起' : '详情'}
        </button>
        <Button size="sm" disabled={installing || !canInstall} onClick={onInstall}>
          {installing ? <RefreshCw size={13} className="animate-spin" /> : <Download size={13} />}
          {installed ? '重装' : '安装'}
        </Button>
      </div>
    </article>
  )
}

function InstalledView({
  installed,
  catalog,
  loading,
  onUninstall,
}: {
  installed: WorkspacePluginBundleRecord[]
  catalog: PluginStoreCatalog | null
  loading: boolean
  onUninstall: (record: WorkspacePluginBundleRecord, name: string) => void
}): JSX.Element {
  if (loading) {
    return (
      <div className="channel-list-loading">
        <RefreshCw size={16} className="animate-spin" />
        正在读取已安装整合包…
      </div>
    )
  }
  if (installed.length === 0) {
    return (
      <div className="channel-empty">
        <Package size={20} />
        <div>
          <strong>尚未安装整合包</strong>
          <p>切换到「市场」标签，选择整合包一键安装。</p>
        </div>
      </div>
    )
  }

  const bundleById = new Map((catalog?.bundles ?? []).map((b) => [b.id, b]))

  return (
    <>
      <div className="channel-settings-summary">
        <span>{installed.length} 个已安装整合包</span>
      </div>
      <section className="channel-group">
        <div className="channel-list">
          {installed.map((record) => {
            const bundle = bundleById.get(record.bundleId)
            const name = bundle?.name ?? record.bundleId
            return (
              <article className="channel-row" key={record.bundleId}>
                <div className="channel-row-topline">
                  <div className="channel-provider-mark">
                    <Package size={15} />
                  </div>
                  <div className="channel-row-identity">
                    <div className="channel-row-title">
                      <strong>{name}</strong>
                      {bundle && <span className="channel-tag">{categoryLabel(bundle.category)}</span>}
                    </div>
                    <p>
                      {record.mcps.length} 个 MCP · {record.skills.length} 个 Skill · 安装于 {formatDate(record.installedAt)}
                    </p>
                  </div>
                  <div className="channel-row-actions">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={`卸载 ${name}`}
                      onClick={() => onUninstall(record, name)}
                    >
                      <Trash2 size={13} />
                    </Button>
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      </section>
    </>
  )
}
