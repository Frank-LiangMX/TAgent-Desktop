/**
 * 协作室成员设置弹出面板（锚定成员气泡，对齐模型选择器形态，不做全局弹窗）。
 *
 * 触发 = 页面传入的成员气泡（children）；面板内可改显示名、执行后端、渠道、模型。
 * 表单控件用 @tagent/ui 主题化组件（Input / Select）。
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
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
} from "@tagent/ui";
import type {
  Channel,
  CliWorkersConfig,
  CollaborationMember,
  CollaborationMemberBackend,
} from "@tagent/shared";

export interface CollaborationMemberSettingsProps {
  member: CollaborationMember;
  channels: Channel[];
  cliWorkers?: CliWorkersConfig | null;
  /** 触发元素（成员气泡按钮） */
  children: ReactNode;
  onSave: (patch: {
    memberId: string;
    displayName: string;
    channelId: string;
    modelId: string;
    backend?: CollaborationMemberBackend;
    cliWorkerId?: string;
    permissionProfile?: "read-only" | "workspace-write";
  }) => void;
  /** 软删除成员；历史记录保留，调用方负责刷新 */
  onRemove?: (memberId: string) => void;
}

export function CollaborationMemberSettings({
  member,
  channels,
  cliWorkers,
  children,
  onSave,
  onRemove,
}: CollaborationMemberSettingsProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [channelId, setChannelId] = useState("");
  const [modelId, setModelId] = useState("");
  const [backend, setBackend] = useState<CollaborationMemberBackend>("channel");
  const [codexRuntimeStatus, setCodexRuntimeStatus] = useState<{
    available: boolean;
    reason?: string;
  } | null>(null);
  const [cliWorkerId, setCliWorkerId] = useState("");
  const [permissionProfile, setPermissionProfile] = useState<
    "read-only" | "workspace-write"
  >("read-only");

  // 每次打开回填当前成员配置
  useEffect(() => {
    if (!open) return;
    setDisplayName(member.displayName);
    setChannelId(member.channelId ?? "");
    setModelId(member.modelId ?? "");
    setBackend(member.backend ?? "channel");
    setCodexRuntimeStatus(null);
    setCliWorkerId(member.cliWorkerId ?? "");
    setPermissionProfile(member.permissionProfile ?? "read-only");
    void window.electronAPI
      .getCodexRuntimeStatus()
      .then((status) => setCodexRuntimeStatus(status))
      .catch((error) =>
        setCodexRuntimeStatus({
          available: false,
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
  }, [open, member]);

  const isBotSnapshot = Boolean(member.botProfileId);

  const enabledChannels = useMemo(
    () => channels.filter((c) => c.enabled),
    [channels],
  );
  const selectedChannel = enabledChannels.find((c) => c.id === channelId);
  const cliWorkerOptions = cliWorkers?.enabled
    ? cliWorkers.workers.filter((worker) => worker.enabled)
    : [];
  const selectedCliWorker = cliWorkerOptions.find(
    (worker) => worker.id === cliWorkerId,
  );
  const enabledModels = selectedChannel?.models.filter((m) => m.enabled) ?? [];

  const submit = (): void => {
    const name = displayName.trim();
    if (!name) return;
    if (backend === "cli" && !selectedCliWorker) return;
    onSave({
      memberId: member.id,
      displayName: name,
      channelId: backend === "cli" || backend === "codex" ? "" : channelId,
      modelId: backend === "cli" || backend === "codex" ? "" : modelId,
      backend,
      cliWorkerId: backend === "cli" ? cliWorkerId : undefined,
      permissionProfile:
        backend === "cli" || backend === "codex"
          ? "workspace-write"
          : permissionProfile,
    });
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="end" side="bottom" sideOffset={6} className="w-80">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-foreground">
            成员设置
            {member.isCoordinator ? (
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                协调者
              </span>
            ) : null}
          </h2>
          <span className="text-[11px] text-muted-foreground">
            {isBotSnapshot
              ? "Bot 配置副本；替换请重新添加"
              : backend === "codex"
                ? "使用本机 Codex 账号 / Runtime"
                : "改渠道/模型后下一次 turn 生效"}
          </span>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          后端：
          {member.backend === "codex"
            ? "Codex（账号 / CLI Runtime）"
            : channels.find((c) => c.id === member.channelId)?.name ?? "未绑定"}
          {member.roleSnapshot.roleId
            ? ` · 角色：${member.roleSnapshot.displayName}`
            : ""}
        </p>

        <label
          className="mt-3 block text-xs text-muted-foreground"
          htmlFor="collab-member-name"
        >
          显示名
        </label>
        <Input
          id="collab-member-name"
          className="mt-1"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
            }
          }}
        />

        <label
          className="mt-3 block text-xs text-muted-foreground"
          htmlFor="collab-member-backend"
        >
          执行后端
        </label>
        <Select
          disabled={isBotSnapshot}
          value={backend}
          onValueChange={(value) => {
            const next = value as CollaborationMemberBackend;
            setBackend(next);
            setChannelId("");
            setModelId("");
            if (next === "cli") setPermissionProfile("workspace-write");
            if (next !== "cli") setCliWorkerId("");
          }}
        >
          <SelectTrigger id="collab-member-backend" className="mt-1">
            <SelectValue placeholder="渠道 / Pi" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="channel">渠道 / Pi</SelectItem>
            <SelectItem
              value="codex"
              disabled={
                backend !== "codex" && codexRuntimeStatus?.available !== true
              }
            >
              Codex（账号 / CLI Runtime）
            </SelectItem>
            {cliWorkerOptions.length > 0 ? (
              <SelectItem value="cli">CLI worker（本机工作区）</SelectItem>
            ) : null}
          </SelectContent>
        </Select>
        {backend === "codex" ? (
          <p className="mt-1.5 text-xs text-primary">
            无需 API Key，直接使用本机 Codex Runtime 的账号认证和默认模型。
          </p>
        ) : codexRuntimeStatus && !codexRuntimeStatus.available ? (
          <p className="mt-1.5 text-xs text-muted-foreground">
            Codex 暂不可用：{codexRuntimeStatus.reason || "未检测到 App Server Runtime"}。
          </p>
        ) : !cliWorkers?.enabled ? (
          <p className="mt-1.5 text-xs text-muted-foreground">
            CLI worker 当前未启用，请先在设置中打开本机 CLI worker 总开关。
          </p>
        ) : cliWorkerOptions.length === 0 ? (
          <p className="mt-1.5 text-xs text-amber-600">
            没有已启用的本机 CLI worker。
          </p>
        ) : null}
        {backend === "cli" && !isBotSnapshot ? (
          <>
            <label
              className="mt-2 block text-xs text-muted-foreground"
              htmlFor="collab-member-cli-worker"
            >
              CLI worker
            </label>
            <Select
              value={cliWorkerId || "none"}
              onValueChange={(value) =>
                setCliWorkerId(value === "none" ? "" : value)
              }
            >
              <SelectTrigger id="collab-member-cli-worker" className="mt-1">
                <SelectValue placeholder="选择本机 worker" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">选择 worker</SelectItem>
                {cliWorkerOptions.map((worker) => (
                  <SelectItem key={worker.id} value={worker.id}>
                    {worker.id}
                    {worker.defaultModel ? " · " + worker.defaultModel : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1.5 text-xs text-amber-600">
              CLI worker 使用房间工作区并需要 workspace-write 权限。
            </p>
          </>
        ) : null}
        <label
          className="mt-3 block text-xs text-muted-foreground"
          htmlFor="collab-member-channel"
        >
          渠道
        </label>
        <Select
          disabled={
            isBotSnapshot || backend === "cli" || backend === "codex"
          }
          value={backend === "codex" ? "codex-runtime" : channelId || "none"}
          onValueChange={(v) => {
            setChannelId(v === "none" ? "" : v);
            setModelId("");
          }}
        >
          <SelectTrigger id="collab-member-channel" className="mt-1">
            <SelectValue placeholder="未绑定" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">未绑定</SelectItem>
            <SelectItem value="codex-runtime">Codex Runtime（无需渠道）</SelectItem>
            {enabledChannels.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <label
          className="mt-3 block text-xs text-muted-foreground"
          htmlFor="collab-member-model"
        >
          模型
        </label>
        <Select
          value={modelId || "default"}
          onValueChange={(v) => setModelId(v === "default" ? "" : v)}
          disabled={
            isBotSnapshot ||
            backend === "cli" ||
            backend === "codex" ||
            !channelId ||
            enabledModels.length === 0
          }
        >
          <SelectTrigger id="collab-member-model" className="mt-1">
            <SelectValue
              placeholder={
                backend === "codex"
                  ? "Codex Runtime 默认模型"
                  : channelId
                    ? "渠道默认"
                    : "先选渠道"
              }
            />
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

        {isBotSnapshot ? (
          <p className="mt-2 text-xs text-muted-foreground">
            该成员是 Bot 在加入房间时的配置快照。要换模型或渠道，请先移除，再从
            Bot 库重新加入。
          </p>
        ) : backend !== "codex" && enabledChannels.length === 0 ? (
          <p className="mt-2 text-xs text-amber-600">
            没有已启用的渠道。请先去设置 → 渠道启用。
          </p>
        ) : null}
        {(member.mentionAliases?.length ?? 0) > 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            旧名仍可 @：{(member.mentionAliases ?? []).join("、")}
          </p>
        ) : null}

        <div className="mt-4 flex items-center justify-between gap-2">
          {onRemove && member.status !== "removed" ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => {
                if (
                  window.confirm("确定移除该成员吗？历史消息和运行记录会保留。")
                ) {
                  onRemove(member.id);
                  setOpen(false);
                }
              }}
            >
              移除成员
            </Button>
          ) : (
            <span />
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={
                !displayName.trim() ||
                member.status === "removed" ||
                (backend === "cli" && !selectedCliWorker)
              }
              onClick={submit}
            >
              保存
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
