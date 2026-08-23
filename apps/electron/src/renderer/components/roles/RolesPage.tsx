/**
 * 角色库主区 — 卡片网格 + 点击弹窗详情
 *
 * 不做左右 master-detail。
 * 卡片有明确 hover / pressed（打开中）选择态。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowsClockwise,
  FileArrowUp,
  MagnifyingGlass,
  Trash,
  CircleNotch,
  CheckCircle,
  UsersThree,
  PushPin,
} from '@phosphor-icons/react'
import {
  AppTooltip,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  SegmentedTabs,
  SegmentedTabsItem,
} from '@tagent/ui'
import type { AgentRoleProfile, RoleStoreCatalogEntry } from '@tagent/shared'
import { DEFAULT_ROLES } from '@tagent/shared'
import { cn } from '../../lib/utils'
import '../../styles/roles-page.css'
import { BotLibraryView } from './BotLibraryView'

const BUILTIN_IDS = new Set(DEFAULT_ROLES.map((r) => r.id))

type PageView = 'team' | 'bots' | 'store'
type TeamFilter = 'all' | 'builtin' | 'custom'

function monogram(name: string): string {
  const t = name.trim()
  return t ? t.charAt(0).toUpperCase() : '?'
}

function permissionLabel(mode: AgentRoleProfile['permissionMode']): string {
  return mode === 'auto' ? '需确认' : '自动执行'
}

function modelPoolLabel(pool: string[] | undefined): string {
  if (!pool?.length) return '渠道默认'
  if (pool.length <= 2) return pool.join(' · ')
  return `${pool.slice(0, 2).join(' · ')} +${pool.length - 2}`
}

export function RolesPage(): JSX.Element {
  const [roles, setRoles] = useState<AgentRoleProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<PageView>('team')
  const [filter, setFilter] = useState<TeamFilter>('all')
  const [query, setQuery] = useState('')
  /** 详情弹窗中的角色（弹窗关闭即清空，不做网格选择态） */
  const [detailRole, setDetailRole] = useState<AgentRoleProfile | null>(null)
  const [storeEntries, setStoreEntries] = useState<RoleStoreCatalogEntry[]>([])
  const [storeSource, setStoreSource] = useState('')
  const [storeLoading, setStoreLoading] = useState(false)
  const [storeQuery, setStoreQuery] = useState('')

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await window.electronAPI.listAgentRoles()
      setRoles(list)
      setDetailRole((prev) => {
        if (!prev) return prev
        return list.find((r) => r.id === prev.id) ?? null
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const loadStore = useCallback(async () => {
    setStoreLoading(true)
    setError(null)
    try {
      const res = await window.electronAPI.listRoleStoreCatalog()
      setStoreEntries(res.catalog.entries)
      setStoreSource(
        res.source === 'builtin' ? '内置目录' : res.source === 'cached' ? '本地缓存' : '远程',
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setStoreLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    if (view === 'store' && storeEntries.length === 0 && !storeLoading) {
      void loadStore()
    }
  }, [view, storeEntries.length, storeLoading, loadStore])

  const stats = useMemo(() => {
    const builtin = roles.filter((r) => BUILTIN_IDS.has(r.id)).length
    return { total: roles.length, builtin, custom: roles.length - builtin }
  }, [roles])

  const filteredRoles = useMemo(() => {
    const q = query.trim().toLowerCase()
    return roles.filter((r) => {
      if (filter === 'builtin' && !BUILTIN_IDS.has(r.id)) return false
      if (filter === 'custom' && BUILTIN_IDS.has(r.id)) return false
      if (!q) return true
      return (
        r.displayName.toLowerCase().includes(q) ||
        r.id.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q)
      )
    })
  }, [roles, filter, query])

  const filteredStore = useMemo(() => {
    const q = storeQuery.trim().toLowerCase()
    if (!q) return storeEntries
    return storeEntries.filter(
      (e) =>
        e.displayName.toLowerCase().includes(q) ||
        e.id.toLowerCase().includes(q) ||
        e.category.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q),
    )
  }, [storeEntries, storeQuery])

  const openRole = (role: AgentRoleProfile) => {
    setDetailRole(role)
  }

  const closeDetail = (open: boolean) => {
    if (!open) setDetailRole(null)
  }

  /** 置顶/取消置顶到 Chat @ 快捷列表（B1 pin 子集）。仅写本地 pinned 标记，不动其余字段。 */
  const togglePin = async (role: AgentRoleProfile) => {
    setBusy(true)
    try {
      const list = await window.electronAPI.saveAgentRole({
        role: { ...role, pinned: !role.pinned },
      })
      setRoles(list)
      setDetailRole((prev) =>
        prev && prev.id === role.id ? list.find((r) => r.id === role.id) ?? prev : prev,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onReset = async () => {
    if (!confirm('将清空自定义角色并恢复 8 个内置角色，确定？')) return
    setBusy(true)
    try {
      const list = await window.electronAPI.resetDefaultAgentRoles()
      setRoles(list)
      setDetailRole(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onDelete = async (roleId: string) => {
    if (BUILTIN_IDS.has(roleId)) return
    if (!confirm(`删除角色「${roleId}」？`)) return
    setBusy(true)
    try {
      const res = await window.electronAPI.deleteAgentRole(roleId)
      setRoles(res.roles)
      if (detailRole?.id === roleId) setDetailRole(null)
      if (!res.deleted && res.reason) setError(res.reason)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onImportMd = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await window.electronAPI.importAgentRoleFromMd()
      if (!res.imported) {
        if (res.reason && res.reason !== '已取消') setError(res.reason)
      } else {
        await reload()
        if (res.role) {
          setDetailRole(res.role)
          setView('team')
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onInstall = async (roleId: string) => {
    setBusy(true)
    setError(null)
    try {
      const res = await window.electronAPI.installStoreRole(roleId)
      if (!res.installed) {
        setError(res.reason ?? '安装失败')
      } else {
        await reload()
        if (res.role) {
          setDetailRole(res.role)
          setView('team')
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-page roles-shell">
      <header className="roles-shell__header-card">
        <div>
          <h2 className="settings-page-intro-title">角色库</h2>
          <p className="settings-page-intro-desc" style={{ marginTop: 6 }}>
            卡片浏览角色，点击打开详情弹窗。主会话默认不绑定岗位。
          </p>
        </div>
        <div className="roles-shell__actions">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || loading}
            onClick={() => void reload()}
            aria-label="刷新"
          >
            <ArrowsClockwise className={cn('size-3.5', loading && 'animate-spin')} weight="bold" />
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void onImportMd()}>
            <FileArrowUp className="mr-1.5 size-3.5" weight="bold" />
            导入
          </Button>
          {view === 'team' && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void onReset()}>
              重置内置
            </Button>
          )}
        </div>
      </header>

      <SegmentedTabs
        value={view}
        onValueChange={(v) => setView(v as PageView)}
        className="settings-segmented"
      >
        <SegmentedTabsItem value="team">我的团队（{stats.total}）</SegmentedTabsItem>
        <SegmentedTabsItem value="bots">Bot 库</SegmentedTabsItem>
        <SegmentedTabsItem value="store">商店</SegmentedTabsItem>
      </SegmentedTabs>

      {error ? (
        <div className="roles-shell__error" role="alert">
          {error}
        </div>
      ) : null}

      {view === 'bots' ? (
        <BotLibraryView />
      ) : view === 'team' ? (
        <>
          <div className="roles-toolbar">
            <div className="roles-search">
              <MagnifyingGlass className="roles-search__icon" weight="bold" aria-hidden />
              <input
                type="search"
                className="roles-search__input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索角色"
                aria-label="搜索角色"
              />
            </div>
            <div className="roles-filters" role="tablist" aria-label="筛选">
              {(
                [
                  ['all', `全部 ${stats.total}`],
                  ['builtin', `内置 ${stats.builtin}`],
                  ['custom', `自定义 ${stats.custom}`],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  className="roles-filters__btn"
                  aria-selected={filter === key}
                  onClick={() => setFilter(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <div className="roles-empty">
              <CircleNotch className="size-4 animate-spin" aria-hidden />
              加载中
            </div>
          ) : filteredRoles.length === 0 ? (
            <div className="roles-empty">
              <UsersThree className="size-8 opacity-30" weight="thin" aria-hidden />
              没有匹配角色
            </div>
          ) : (
            <ul className="roles-card-grid">
              {filteredRoles.map((r) => {
                const builtin = BUILTIN_IDS.has(r.id)
                const pinned = r.pinned === true
                return (
                  <li key={r.id} className="relative">
                    <button
                      type="button"
                      className="roles-card"
                      onClick={() => openRole(r)}
                    >
                      <div className="roles-card__top">
                        <span className="roles-avatar" aria-hidden>
                          {monogram(r.displayName)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <h3 className="roles-card__title">{r.displayName}</h3>
                          <div className="roles-card__meta">
                            <span className="roles-badge">{builtin ? '内置' : '自定义'}</span>
                            <span className="roles-badge">{permissionLabel(r.permissionMode)}</span>
                            {pinned ? <span className="roles-badge roles-badge--pin">已置顶</span> : null}
                          </div>
                        </div>
                      </div>
                      <p className="roles-card__desc">{r.description || r.id}</p>
                      <div className="roles-card__foot">
                        <span className="truncate">{modelPoolLabel(r.modelPool)}</span>
                        <span className="roles-card__foot-hint">查看详情</span>
                      </div>
                    </button>
                    {/* 置顶到 @ 快捷列表：放在卡片按钮之外（避免 button 嵌 button），右上角浮层 */}
                    <AppTooltip
                      label={
                        pinned ? '已置顶到 Chat @ 快捷列表（点击取消）' : '置顶到 Chat @ 快捷列表'
                      }
                    >
                      <button
                        type="button"
                        className={cn(
                          'roles-card__pin',
                          pinned && 'roles-card__pin--active',
                        )}
                        onClick={(e) => {
                          e.stopPropagation()
                          void togglePin(r)
                        }}
                        disabled={busy}
                        aria-label={pinned ? '取消置顶' : '置顶到 @ 快捷列表'}
                        aria-pressed={pinned}
                      >
                        <PushPin weight={pinned ? 'fill' : 'regular'} aria-hidden />
                      </button>
                    </AppTooltip>
                  </li>
                )
              })}
            </ul>
          )}
        </>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="roles-store-toolbar">
            <div className="roles-search">
              <MagnifyingGlass className="roles-search__icon" weight="bold" aria-hidden />
              <input
                type="search"
                className="roles-search__input"
                value={storeQuery}
                onChange={(e) => setStoreQuery(e.target.value)}
                placeholder="搜索商店"
                aria-label="搜索商店角色"
              />
            </div>
            <span className="roles-store-meta">
              {storeSource || '目录'} · {filteredStore.length} 项
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={storeLoading}
              onClick={() => void loadStore()}
              aria-label="刷新商店"
            >
              <ArrowsClockwise
                className={cn('size-3.5', storeLoading && 'animate-spin')}
                weight="bold"
              />
            </Button>
          </div>

          {storeLoading && storeEntries.length === 0 ? (
            <div className="roles-empty">
              <CircleNotch className="size-4 animate-spin" aria-hidden />
              加载商店
            </div>
          ) : filteredStore.length === 0 ? (
            <div className="roles-empty">没有匹配项</div>
          ) : (
            <ul className="roles-card-grid">
              {filteredStore.map((e) => {
                const installed = roles.some((r) => r.id === e.id)
                return (
                  <li key={e.id}>
                    <div className="roles-card" style={{ cursor: 'default' }}>
                      <div className="roles-card__top">
                        <span className="roles-avatar" aria-hidden>
                          {monogram(e.displayName)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <h3 className="roles-card__title">{e.displayName}</h3>
                          <div className="roles-card__meta">
                            <span className="roles-badge">{e.category}</span>
                            {e.tier === 'recommended' ? (
                              <span className="roles-badge">推荐</span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                      <p className="roles-card__desc">{e.description}</p>
                      <div className="roles-card__foot" style={{ justifyContent: 'flex-end' }}>
                        <Button
                          size="sm"
                          variant={installed ? 'ghost' : 'secondary'}
                          disabled={busy || installed}
                          onClick={() => void onInstall(e.id)}
                        >
                          {installed ? (
                            <>
                              <CheckCircle className="mr-1 size-3.5 text-primary" weight="fill" />
                              已安装
                            </>
                          ) : (
                            '安装到团队'
                          )}
                        </Button>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      {/* 详情弹窗 */}
      <Dialog open={detailRole != null} onOpenChange={closeDetail}>
        <DialogContent className="roles-dialog session-glass-modal max-h-[min(88vh,980px)] w-[clamp(480px,46vw,800px)] gap-0 overflow-hidden p-0 sm:max-w-none">
          {detailRole ? (
            <>
              <div className="roles-dialog__head border-b border-border/50">
                <DialogTitle className="text-base font-semibold tracking-tight">
                  {detailRole.displayName}
                </DialogTitle>
                <DialogDescription className="mt-1 font-mono text-[11.5px] text-muted-foreground">
                  {detailRole.id}
                </DialogDescription>
              </div>

              <div className="roles-dialog-body px-5 pb-2">
                <div className="roles-dialog-identity">
                  <span className="roles-dialog-identity__avatar" aria-hidden>
                    {monogram(detailRole.displayName)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="roles-dialog-identity__title">{detailRole.displayName}</p>
                    <p className="roles-dialog-identity__id">{detailRole.id}</p>
                    <span className="roles-badge mt-2 inline-flex">
                      {BUILTIN_IDS.has(detailRole.id) ? '内置角色' : '自定义角色'}
                    </span>
                    <p className="roles-dialog-identity__desc">{detailRole.description}</p>
                  </div>
                </div>

                <div className="roles-stats">
                  <div className="roles-stat">
                    <span className="roles-stat__label">权限</span>
                    <span className="roles-stat__value">
                      {permissionLabel(detailRole.permissionMode)}
                    </span>
                  </div>
                  <div className="roles-stat">
                    <span className="roles-stat__label">模型池</span>
                    <span className="roles-stat__value">
                      {modelPoolLabel(detailRole.modelPool)}
                    </span>
                  </div>
                  <div className="roles-stat">
                    <span className="roles-stat__label">并发</span>
                    <span className="roles-stat__value">{detailRole.maxConcurrentPerModel}</span>
                  </div>
                </div>

                <div className="roles-prompt-well">
                  <div className="roles-prompt-well__head">
                    <h3 className="roles-prompt-well__title">System Prompt</h3>
                    <span className="roles-prompt-well__meta">
                      {detailRole.systemPrompt.length.toLocaleString()} 字
                    </span>
                  </div>
                  <pre className="roles-prompt-well__body">{detailRole.systemPrompt}</pre>
                </div>
              </div>

              <div className="roles-dialog__foot flex items-center justify-between gap-2 border-t border-border/50">
                {!BUILTIN_IDS.has(detailRole.id) ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    disabled={busy}
                    onClick={() => void onDelete(detailRole.id)}
                  >
                    <Trash className="mr-1 size-3.5" weight="bold" />
                    删除
                  </Button>
                ) : (
                  <span className="roles-dialog__foot-hint text-[12px] text-muted-foreground">
                    内置角色不可删除
                  </span>
                )}
                <Button size="sm" variant="secondary" onClick={() => setDetailRole(null)}>
                  关闭
                </Button>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}

export { RolesPage as RolesSettings }
