/**
 * 插件主页（工作区维度）— Rail 一级入口，对齐 TAgent_General skills
 *
 * 产品单位 = 整合包 Bundle（Cursor/Codex/TAgent_General 风格）。
 * - 市场：干净卡片网格；点击整卡打开详情弹窗（对齐 General 详情布局）
 * - 已安装：列表，可卸载；点行亦可打开详情
 * - MCP：手动配置自定义服务器
 */
import { useEffect, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  AlertCircle,
  CheckCircle2,
  Download,
  ExternalLink,
  Loader2,
  Package,
  Plug,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react'
import {
  Button,
  DestructiveConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
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
  dev: '开发工具',
  ta: 'TA 专用',
  workflow: '工作流',
  office: '办公文档',
  planning: '任务规划',
  meta: '扩展能力',
}

function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category
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
  const [detailBundleId, setDetailBundleId] = useState<string | null>(null)
  const [installingId, setInstallingId] = useState<string | null>(null)
  const [installResults, setInstallResults] = useState<Record<string, InstallNotice>>({})
  const [uninstallTarget, setUninstallTarget] = useState<{ bundleId: string; name: string } | null>(null)
  const [pageError, setPageError] = useState('')

  useEffect(() => {
    void loadWorkspaces()
  }, [loadWorkspaces])

  useEffect(() => {
    if (!selectedId && workspaces.length > 0) {
      const first = workspaces[0]
      if (first) setSelectedId(first.id)
    }
  }, [workspaces, selectedId])

  const slug = selectedId

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

  useEffect(() => {
    setInstallResults({})
    void reloadInstalled()
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
    try {
      const result = await window.electronAPI.uninstallStoreBundle(slug, target.bundleId)
      if (!result.ok) throw new Error('该整合包未安装，无需卸载')
      if (detailBundleId === target.bundleId) setDetailBundleId(null)
      await reloadInstalled()
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : '卸载失败')
    }
  }

  const detailBundle =
    detailBundleId && catalog
      ? (catalog.bundles.find((b) => b.id === detailBundleId) ?? null)
      : null

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
          installingId={installingId}
          installResults={installResults}
          canInstall={Boolean(slug)}
          onOpenDetail={(id) => setDetailBundleId(id)}
          onInstall={installBundle}
        />
      ) : view === 'installed' ? (
        <InstalledView
          installed={installed}
          catalog={catalog}
          loading={loadingInstalled}
          onOpenDetail={(id) => setDetailBundleId(id)}
          onUninstall={(record, name) => setUninstallTarget({ bundleId: record.bundleId, name })}
        />
      ) : (
        <McpSettings embedded workspaceId={slug} />
      )}

      <BundleDetailDialog
        open={detailBundleId != null}
        bundle={detailBundle}
        catalog={catalog}
        installed={detailBundle ? installedIds.has(detailBundle.id) : false}
        installing={detailBundle ? installingId === detailBundle.id : false}
        notice={detailBundle ? installResults[detailBundle.id] : undefined}
        canInstall={Boolean(slug)}
        onOpenChange={(open) => {
          if (!open) setDetailBundleId(null)
        }}
        onInstall={() => {
          if (detailBundle) void installBundle(detailBundle)
        }}
        onUninstall={() => {
          if (!detailBundle) return
          setUninstallTarget({ bundleId: detailBundle.id, name: detailBundle.name })
        }}
      />

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
  installingId,
  installResults,
  canInstall,
  onOpenDetail,
  onInstall,
}: {
  catalog: PluginStoreCatalog | null
  loadingCatalog: boolean
  installedIds: Set<string>
  installingId: string | null
  installResults: Record<string, InstallNotice>
  canInstall: boolean
  onOpenDetail: (id: string) => void
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

  return (
    <>
      <div className="channel-settings-summary">
        <span>{bundles.length} 个整合包</span>
        <span aria-hidden>·</span>
        <span>点击卡片查看详情</span>
      </div>
      <div className="plugin-bundle-grid">
        {bundles.map((bundle) => (
          <BundleCard
            key={bundle.id}
            bundle={bundle}
            installed={installedIds.has(bundle.id)}
            installing={installingId === bundle.id}
            notice={installResults[bundle.id]}
            canInstall={canInstall}
            onSelect={() => onOpenDetail(bundle.id)}
            onInstall={() => onInstall(bundle)}
          />
        ))}
      </div>
    </>
  )
}

/** 市场卡片 — 对齐 General MarketplaceBundleCard 节奏：头 / 描述 / 底栏安装 */
function BundleCard({
  bundle,
  installed,
  installing,
  notice,
  canInstall,
  onSelect,
  onInstall,
}: {
  bundle: StorePluginBundle
  installed: boolean
  installing: boolean
  notice: InstallNotice | undefined
  canInstall: boolean
  onSelect: () => void
  onInstall: () => void
}): JSX.Element {
  return (
    <div
      role="button"
      tabIndex={0}
      className="plugin-bundle-card"
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
    >
      <div className="plugin-bundle-card-head">
        <div className="plugin-bundle-logo" aria-hidden>
          <Package size={16} strokeWidth={1.75} />
        </div>
        <div className="plugin-bundle-card-identity">
          <div className="plugin-bundle-card-title-row">
            <h3 className="plugin-bundle-card-name">{bundle.name}</h3>
            {bundle.tier === 'recommended' && (
              <span className="plugin-bundle-pill">推荐</span>
            )}
          </div>
          <p className="plugin-bundle-card-kind">
            整合包 · MCP ×{bundle.mcps.length} · Skill ×{bundle.skills.length}
          </p>
        </div>
      </div>

      <p className="plugin-bundle-card-desc">{bundle.description}</p>

      {notice && (
        <div className={`plugin-bundle-notice plugin-bundle-notice--${notice.kind}`} role="status">
          {notice.kind === 'success' ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
          <span>{notice.message}</span>
        </div>
      )}

      <div
        className="plugin-bundle-card-foot"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <span className="plugin-bundle-card-category">{categoryLabel(bundle.category)}</span>
        {installed ? (
          <span className="plugin-bundle-installed-mark">
            <CheckCircle2 size={12} strokeWidth={1.75} />
            已安装
          </span>
        ) : (
          <button
            type="button"
            className="plugin-bundle-install-btn"
            disabled={installing || !canInstall}
            onClick={onInstall}
          >
            {installing ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Download size={12} />
            )}
            {installing ? '安装中…' : '安装'}
          </button>
        )}
      </div>
    </div>
  )
}

function InstalledView({
  installed,
  catalog,
  loading,
  onOpenDetail,
  onUninstall,
}: {
  installed: WorkspacePluginBundleRecord[]
  catalog: PluginStoreCatalog | null
  loading: boolean
  onOpenDetail: (id: string) => void
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
        <span aria-hidden>·</span>
        <span>点击查看详情</span>
      </div>
      <section className="channel-group">
        <div className="channel-list">
          {installed.map((record) => {
            const bundle = bundleById.get(record.bundleId)
            const name = bundle?.name ?? record.bundleId
            return (
              <article
                className="channel-row plugin-installed-row"
                key={record.bundleId}
                role="button"
                tabIndex={0}
                onClick={() => onOpenDetail(record.bundleId)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onOpenDetail(record.bundleId)
                  }
                }}
              >
                <div className="channel-row-topline">
                  <div className="plugin-bundle-logo plugin-bundle-logo--sm" aria-hidden>
                    <Package size={14} strokeWidth={1.75} />
                  </div>
                  <div className="channel-row-identity">
                    <div className="channel-row-title">
                      <strong>{name}</strong>
                      {bundle && <span className="channel-tag">{categoryLabel(bundle.category)}</span>}
                    </div>
                    <p>
                      {record.mcps.length} 个 MCP · {record.skills.length} 个 Skill · 安装于{' '}
                      {formatDate(record.installedAt)}
                    </p>
                  </div>
                  <div
                    className="channel-row-actions"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
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

/** 详情弹窗 — 对齐 General PluginMarketplaceBundleDetail 信息结构 */
function BundleDetailDialog({
  open,
  bundle,
  catalog,
  installed,
  installing,
  notice,
  canInstall,
  onOpenChange,
  onInstall,
  onUninstall,
}: {
  open: boolean
  bundle: StorePluginBundle | null
  catalog: PluginStoreCatalog | null
  installed: boolean
  installing: boolean
  notice: InstallNotice | undefined
  canInstall: boolean
  onOpenChange: (open: boolean) => void
  onInstall: () => void
  onUninstall: () => void
}): JSX.Element {
  const mcps =
    bundle && catalog
      ? bundle.mcps
          .map((name) => catalog.mcps.find((m) => m.name === name))
          .filter((m): m is BuiltinMcpCatalogEntry => Boolean(m))
      : []
  const skills =
    bundle && catalog
      ? bundle.skills
          .map((slug) => catalog.skills.find((s) => s.slug === slug))
          .filter((s): s is PluginStoreSkillEntry => Boolean(s))
      : []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="plugin-detail-dialog !gap-0 !p-0 !overflow-hidden"
        aria-describedby="plugin-detail-desc"
      >
        {!bundle ? (
          <div className="plugin-detail-shell" style={{ padding: 24 }}>
            <DialogTitle className="plugin-detail-title">整合包不存在</DialogTitle>
            <DialogDescription id="plugin-detail-desc" className="plugin-detail-id">
              目录中找不到该整合包，可能已被移除。
            </DialogDescription>
          </div>
        ) : (
          <div className="plugin-detail-shell">
            <header className="plugin-detail-header">
              <div className="plugin-detail-header-main">
                <div className="plugin-bundle-logo plugin-bundle-logo--lg" aria-hidden>
                  <Package size={22} strokeWidth={1.75} />
                </div>
                <div className="plugin-detail-titles">
                  <DialogTitle className="plugin-detail-title">{bundle.name}</DialogTitle>
                  <DialogDescription id="plugin-detail-desc" className="plugin-detail-id">
                    {bundle.id} · {bundle.publisher}
                  </DialogDescription>
                </div>
              </div>
              <div className="plugin-detail-header-actions">
                {installed ? (
                  <>
                    <span className="plugin-bundle-installed-mark">
                      <CheckCircle2 size={14} strokeWidth={1.75} />
                      已安装
                    </span>
                    <Button variant="outline" size="sm" onClick={onUninstall}>
                      <Trash2 size={13} />
                      卸载
                    </Button>
                  </>
                ) : (
                  <Button size="sm" disabled={installing || !canInstall} onClick={onInstall}>
                    {installing ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Download size={14} />
                    )}
                    {installing ? '安装中…' : '安装'}
                  </Button>
                )}
              </div>
            </header>

            <div className="plugin-detail-body scrollbar-thin">
              <aside className="plugin-detail-meta">
                <MetaItem label="分类" value={categoryLabel(bundle.category)} />
                <MetaItem
                  label="包含"
                  value={`MCP ×${bundle.mcps.length} · Skill ×${bundle.skills.length}`}
                />
                {bundle.tier === 'recommended' && <MetaItem label="层级" value="推荐" />}
                <div className="plugin-detail-meta-item">
                  <dt>源码</dt>
                  <dd>
                    <button
                      type="button"
                      className="plugin-detail-link"
                      onClick={() => window.open(bundle.repositoryUrl, '_blank')}
                    >
                      查看仓库
                      <ExternalLink size={11} />
                    </button>
                  </dd>
                </div>
                {bundle.homepageUrl && (
                  <div className="plugin-detail-meta-item">
                    <dt>主页</dt>
                    <dd>
                      <button
                        type="button"
                        className="plugin-detail-link"
                        onClick={() => window.open(bundle.homepageUrl, '_blank')}
                      >
                        打开
                        <ExternalLink size={11} />
                      </button>
                    </dd>
                  </div>
                )}
              </aside>

              <div className="plugin-detail-main">
                <p className="plugin-detail-desc">{bundle.description}</p>

                {notice && (
                  <div
                    className={`plugin-bundle-notice plugin-bundle-notice--${notice.kind}`}
                    role="status"
                  >
                    {notice.kind === 'success' ? (
                      <CheckCircle2 size={13} />
                    ) : (
                      <AlertCircle size={13} />
                    )}
                    <span>{notice.message}</span>
                  </div>
                )}

                {mcps.length > 0 && (
                  <section className="plugin-detail-section">
                    <h3>
                      MCP <span>{mcps.length}</span>
                    </h3>
                    <div className="plugin-detail-sublist">
                      {mcps.map((mcp) => (
                        <BundleSubItem
                          key={mcp.name}
                          kind="mcp"
                          title={mcp.displayName}
                          description={mcp.description}
                        />
                      ))}
                    </div>
                  </section>
                )}

                {skills.length > 0 && (
                  <section className="plugin-detail-section">
                    <h3>
                      Skill <span>{skills.length}</span>
                    </h3>
                    <div className="plugin-detail-sublist">
                      {skills.map((skill) => (
                        <BundleSubItem
                          key={skill.slug}
                          kind="skill"
                          title={skill.name}
                          description={skill.description}
                        />
                      ))}
                    </div>
                  </section>
                )}

                {mcps.length === 0 && skills.length === 0 && (
                  <p className="plugin-detail-empty">该整合包尚未收录 MCP / Skill 明细。</p>
                )}
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function MetaItem({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="plugin-detail-meta-item">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function BundleSubItem({
  kind,
  title,
  description,
}: {
  kind: 'mcp' | 'skill'
  title: string
  description: string
}): JSX.Element {
  return (
    <div className="plugin-detail-subitem">
      <span
        className={`plugin-detail-subitem-icon plugin-detail-subitem-icon--${kind}`}
        aria-hidden
      >
        {kind === 'mcp' ? (
          <Plug size={15} strokeWidth={1.75} />
        ) : (
          <Sparkles size={15} strokeWidth={1.75} />
        )}
      </span>
      <div className="plugin-detail-subitem-body">
        <p className="plugin-detail-subitem-title">{title}</p>
        <p className="plugin-detail-subitem-desc">{description}</p>
      </div>
    </div>
  )
}
