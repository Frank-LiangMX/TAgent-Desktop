/**
 * 设置 · 融合会话「协作与网络」危险区（P0-3b）。
 *
 * 把 P0-3 已落地的 prefs IPC + 证书 IPC 接到用户可操作的设置页危险区，并补齐闸门状态
 * 可读性。**默认仍全关**；本切片**不**自动对公网 / `0.0.0.0` 起监听。
 *
 * 闸门变更应用策略：**策略 B**——所有闸门变更提示「重启应用后生效」，设置页显示待重启
 * 徽章；不动态注册 / 卸载协作室 IPC（详见 12-IMPLEMENTATION-LOG §75）。`gate-status` 的
 * `needsRestart` 由主进程比对「当前决策」与「启动应用决策」得到。
 *
 * UX 约束（与 brief 一致）：
 *   - `enableNetworkListen` 在 `!enableCollaboration` 或 `!hasActiveCert` 时 Switch disabled。
 *   - 生成证书成功后刷新列表与 gate-status；撤销当前唯一 active 证书后 gate-status 显示非 loopback 未放行。
 *   - 不在 UI 展示私钥（证书记录已由主进程剥离 `key`）。
 *
 * 视觉沿用现有设置页：`SettingsSection` / `SettingsCard` / `settings-row` / `Switch` / `Button`，
 * 不新增 CSS 文件或第二套样式。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Loader2,
  Plus,
  RotateCcw,
  ShieldAlert,
} from 'lucide-react'
import { Button, SettingsCard, SettingsSection, Switch } from '@tagent/ui'
import {
  canEnableNetworkListen,
  certStatusLabel,
  formatCertExpiry,
  networkListenDisabledReason,
  shortFingerprint,
  summarizeGateStatus,
  type FusionRoomCertRecordView,
  type FusionRoomGateStatusView,
  type FusionRoomNetworkPrefsView,
} from './fusion-room-network-settings-model'

type Notice = { kind: 'success' | 'error'; message: string } | null

const DEFAULT_PREFS: FusionRoomNetworkPrefsView = {
  enableCollaboration: false,
  enableNetworkListen: false,
}

function hasActiveCert(certs: FusionRoomCertRecordView[]): boolean {
  return certs.some((c) => c.status === 'active')
}

export function FusionRoomNetworkSettings(): JSX.Element {
  const [prefs, setPrefs] = useState<FusionRoomNetworkPrefsView | null>(null)
  const [certs, setCerts] = useState<FusionRoomCertRecordView[]>([])
  const [gate, setGate] = useState<FusionRoomGateStatusView | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [toggling, setToggling] = useState<'collab' | 'listen' | null>(null)
  const [certBusy, setCertBusy] = useState(false)

  const reload = useCallback(async (): Promise<void> => {
    try {
      const [p, c, g] = await Promise.all([
        window.electronAPI.getFusionRoomNetworkPrefs(),
        window.electronAPI.listFusionRoomCerts(),
        window.electronAPI.getFusionRoomGateStatus(),
      ])
      setPrefs(p)
      setCerts(c)
      setGate(g)
    } catch (e) {
      setNotice({
        kind: 'error',
        message: e instanceof Error ? e.message : '无法读取融合会话网络偏好',
      })
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const refreshGate = useCallback(async (): Promise<void> => {
    try {
      setGate(await window.electronAPI.getFusionRoomGateStatus())
    } catch {
      // gate-status 读失败不阻塞偏好写入；下次 reload 会重试。
    }
  }, [])

  const handleToggleCollab = useCallback(
    async (v: boolean): Promise<void> => {
      setToggling('collab')
      setNotice(null)
      try {
        // 关闭协作时连带关闭网络监听：否则 set 会因「enableNetworkListen 缺 enableCollaboration」被拒。
        const patch: { enableCollaboration: boolean; enableNetworkListen?: boolean } = {
          enableCollaboration: v,
        }
        if (!v) patch.enableNetworkListen = false
        const next = await window.electronAPI.setFusionRoomNetworkPrefs(patch)
        setPrefs(next)
        await refreshGate()
        setNotice({
          kind: 'success',
          message: v
            ? '已开启协作室 IPC（重启应用后生效）'
            : '已关闭协作室 IPC（重启应用后生效）',
        })
      } catch (e) {
        setNotice({ kind: 'error', message: e instanceof Error ? e.message : '保存失败' })
      } finally {
        setToggling(null)
      }
    },
    [refreshGate],
  )

  const handleToggleListen = useCallback(
    async (v: boolean): Promise<void> => {
      setToggling('listen')
      setNotice(null)
      try {
        const next = await window.electronAPI.setFusionRoomNetworkPrefs({
          enableNetworkListen: v,
        })
        setPrefs(next)
        await refreshGate()
        setNotice({
          kind: 'success',
          message: v
            ? '已开启非 loopback 监听（需有效证书且重启后生效）'
            : '已关闭非 loopback 监听（重启应用后生效）',
        })
      } catch (e) {
        setNotice({ kind: 'error', message: e instanceof Error ? e.message : '保存失败' })
      } finally {
        setToggling(null)
      }
    },
    [refreshGate],
  )

  const handleGenerate = useCallback(async (): Promise<void> => {
    setCertBusy(true)
    setNotice(null)
    try {
      await window.electronAPI.generateFusionRoomCert()
      const [c, g] = await Promise.all([
        window.electronAPI.listFusionRoomCerts(),
        window.electronAPI.getFusionRoomGateStatus(),
      ])
      setCerts(c)
      setGate(g)
      setNotice({ kind: 'success', message: '已生成自签证书' })
    } catch (e) {
      setNotice({ kind: 'error', message: e instanceof Error ? e.message : '生成证书失败' })
    } finally {
      setCertBusy(false)
    }
  }, [])

  const handleRevoke = useCallback(async (certId: string): Promise<void> => {
    setCertBusy(true)
    setNotice(null)
    try {
      await window.electronAPI.revokeFusionRoomCert(certId)
      const [c, g] = await Promise.all([
        window.electronAPI.listFusionRoomCerts(),
        window.electronAPI.getFusionRoomGateStatus(),
      ])
      setCerts(c)
      setGate(g)
      setNotice({ kind: 'success', message: '已撤销证书' })
    } catch (e) {
      setNotice({ kind: 'error', message: e instanceof Error ? e.message : '撤销证书失败' })
    } finally {
      setCertBusy(false)
    }
  }, [])

  const loaded = prefs !== null && gate !== null
  const currentPrefs = prefs ?? DEFAULT_PREFS
  const active = hasActiveCert(certs)
  const listenDisabled = !loaded || !canEnableNetworkListen(currentPrefs, active)
  const listenDisabledReason = networkListenDisabledReason(currentPrefs, active)
  const summary = gate ? summarizeGateStatus(gate) : null

  return (
    <SettingsSection
      title={
        <span className="inline-flex items-center gap-1.5">
          <ShieldAlert size={14} strokeWidth={1.75} aria-hidden="true" />
          融合会话 · 协作与网络（危险区）
        </span>
      }
      description="打包版默认关闭协作室 IPC 与非 loopback 监听。以下开关仅在本机持久化偏好，重启后生效。"
    >
      <div className="agent-behavior-notice agent-behavior-notice--error" role="note">
        <AlertTriangle size={15} aria-hidden="true" />
        <span className="agent-behavior-notice-copy">
          默认关闭。开启网络监听不等于真实账户认证已完成；无真实账户认证前仅限受信局域网试验。撤销 / 过期证书不再放行非 loopback。
        </span>
      </div>

      {notice ? (
        <div
          className={`agent-behavior-notice ${
            notice.kind === 'error'
              ? 'agent-behavior-notice--error'
              : 'agent-behavior-notice--success'
          }`}
          role={notice.kind === 'error' ? 'alert' : 'status'}
        >
          {notice.kind === 'error' ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
          <span className="agent-behavior-notice-copy">{notice.message}</span>
        </div>
      ) : null}

      <SettingsCard divided={false}>
        <div className="settings-row">
          <div className="settings-row-main min-w-0 flex-1">
            <span className="settings-field-label">启用协作室 IPC</span>
            <div className="settings-row-bottom mt-1">
              <span className="text-xs leading-relaxed text-muted-foreground">
                打包版注册本地协作室 IPC 与房间 UI 入口；关闭后打包版不注册（开发环境恒开，不受此开关影响）。
              </span>
            </div>
          </div>
          <div className="settings-row-control shrink-0">
            <Switch
              checked={currentPrefs.enableCollaboration}
              onCheckedChange={(v) => void handleToggleCollab(v)}
              disabled={!loaded || toggling === 'collab'}
              aria-label="启用协作室 IPC"
            />
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-main min-w-0 flex-1">
            <span className="settings-field-label">允许非 loopback 监听</span>
            <div className="settings-row-bottom mt-1">
              <span className="text-xs leading-relaxed text-muted-foreground">
                允许 FusionRoom transport 绑定非 loopback 地址；需先开启协作室 IPC 且存在一张有效证书。
                {listenDisabledReason ? `（${listenDisabledReason}）` : ''}
              </span>
            </div>
          </div>
          <div className="settings-row-control shrink-0">
            <Switch
              checked={currentPrefs.enableNetworkListen}
              onCheckedChange={(v) => void handleToggleListen(v)}
              disabled={listenDisabled || toggling === 'listen'}
              aria-label="允许非 loopback 监听"
            />
          </div>
        </div>
      </SettingsCard>

      <SettingsCard divided={false}>
        <div className="settings-row">
          <div className="settings-row-main min-w-0 flex-1">
            <span className="settings-field-label">TLS 证书</span>
            <div className="settings-row-bottom mt-1">
              <span className="text-xs leading-relaxed text-muted-foreground">
                本地自签证书（RSA 2048 / SHA256，SAN: localhost + 127.0.0.1），仅用于开发 / 自托管 RoomSession HTTPS。不展示私钥。
              </span>
            </div>
          </div>
          <div className="settings-row-control shrink-0">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleGenerate()}
              disabled={!loaded || certBusy}
            >
              {certBusy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              生成自签证书
            </Button>
          </div>
        </div>

        {certs.length === 0 ? (
          <p className="settings-card-footnote agent-behavior-field-hint">
            暂无证书。生成一张有效证书后，方可开启非 loopback 监听。
          </p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="TLS 证书列表">
            {certs.map((c) => {
              const statusTone =
                c.status === 'active'
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : c.status === 'revoked'
                    ? 'text-muted-foreground line-through'
                    : 'text-amber-600 dark:text-amber-400'
              return (
                <li
                  key={c.certId}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
                >
                  <span
                    className="inline-flex items-center gap-1 font-mono text-muted-foreground"
                    title={c.fingerprint}
                  >
                    <KeyRound size={13} aria-hidden="true" />
                    {shortFingerprint(c.fingerprint)}
                  </span>
                  <span className={`rounded bg-muted px-1.5 py-0.5 ${statusTone}`} data-status={c.status}>
                    {certStatusLabel(c.status)}
                  </span>
                  <span className="text-muted-foreground">过期 {formatCertExpiry(c.expiresAt)}</span>
                  {c.status === 'active' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void handleRevoke(c.certId)}
                      disabled={certBusy}
                      aria-label="撤销该证书"
                    >
                      <RotateCcw size={13} />
                      撤销
                    </Button>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </SettingsCard>

      <SettingsCard divided={false}>
        <div className="settings-row">
          <div className="settings-row-main min-w-0 flex-1">
            <span className="settings-field-label">当前闸门状态</span>
            <div className="settings-row-bottom mt-1">
              <span className="text-xs leading-relaxed text-muted-foreground">
                只读展示本次启动实际放行情况。{gate?.isPackaged ? '' : '开发环境协作室 IPC 恒开，以下开关仅配置打包版行为。'}
              </span>
            </div>
          </div>
          {summary ? (
            <div className="settings-row-control shrink-0 text-right text-xs leading-relaxed">
              <GateLine label={summary.ipc} tone={summary.tone} />
              <GateLine label={summary.listen} tone={summary.tone} />
            </div>
          ) : null}
        </div>
        {gate?.needsRestart ? (
          <div className="settings-card-footnote">
            <p className="agent-behavior-field-hint">
              <AlertTriangle size={12} className="inline-block align-text-bottom" aria-hidden="true" />{' '}
              偏好已变更，需重启应用后生效。
            </p>
          </div>
        ) : null}
      </SettingsCard>
    </SettingsSection>
  )
}

function GateLine({ label, tone }: { label: string; tone: 'off' | 'warn' | 'ok' }): JSX.Element {
  const color =
    tone === 'ok'
      ? 'text-emerald-600 dark:text-emerald-400'
      : tone === 'warn'
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-muted-foreground'
  return (
    <div className={color} data-tone={tone}>
      {label}
    </div>
  )
}
