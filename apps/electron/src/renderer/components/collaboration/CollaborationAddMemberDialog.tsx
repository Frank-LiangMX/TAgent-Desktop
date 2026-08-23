/**
 * 协作室「添加成员」弹出面板（对齐模型选择器形态：锚定按钮的 Popover，不做全局弹窗）。
 *
 * 字段：显示名 + 内核（渠道）+ 模型 + 是否协调者 + 角色（角色库 / 自定义 prompt）。
 * - 内核 = 渠道（kscc 内网走 kscc CLI；外部渠道走 Pi HTTP）
 * - 不选渠道时由主进程自动绑定默认渠道（kscc 优先），与建房间行为一致
 * - 模型随渠道联动；选「渠道默认」则不传 modelId
 * 表单控件全部用 @tagent/ui 主题化组件（Input / Select / Textarea / Switch）。
 */
import { useEffect, useMemo, useState } from "react";
import { UserPlus } from "@phosphor-icons/react";
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
  Switch,
  Textarea,
} from "@tagent/ui";
import type {
  AgentRoleProfile,
  BotProfileRecord,
  CliWorkersConfig,
  CollaborationMemberBackend,
  Channel,
  CollaborationRoleSnapshot,
} from "@tagent/shared";

type RoleMode = "none" | "library" | "custom";

export interface CollaborationAddMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  channels: Channel[];
  cliWorkers?: CliWorkersConfig | null;
  onSave: (patch: {
    displayName: string;
    channelId: string;
    modelId: string;
    backend: CollaborationMemberBackend;
    cliWorkerId?: string;
    permissionProfile?: "read-only" | "workspace-write";
    isCoordinator: boolean;
    roleId?: string;
    roleSnapshot?: CollaborationRoleSnapshot;
    botProfileId?: string;
  }) => void;
}

export function CollaborationAddMemberDialog({
  open,
  onOpenChange,
  disabled = false,
  channels,
  cliWorkers,
  onSave,
}: CollaborationAddMemberDialogProps): JSX.Element {
  const [displayName, setDisplayName] = useState("");
  const [bots, setBots] = useState<BotProfileRecord[]>([]);
  const [selectedBotId, setSelectedBotId] = useState("");
  const [channelId, setChannelId] = useState("");
  const [modelId, setModelId] = useState("");
  const [backend, setBackend] = useState<CollaborationMemberBackend>("channel");
  const [cliWorkerId, setCliWorkerId] = useState("");
  const [isCoordinator, setIsCoordinator] = useState(false);
  const [roles, setRoles] = useState<AgentRoleProfile[]>([]);
  const [roleMode, setRoleMode] = useState<RoleMode>("none");
  const [selectedRoleId, setSelectedRoleId] = useState("");
  const [customPrompt, setCustomPrompt] = useState("");

  // 每次打开重置表单
  useEffect(() => {
    if (!open) return;
    setDisplayName("");
    setSelectedBotId("");
    setBots([]);
    setChannelId("");
    setModelId("");
    setBackend("channel");
    setCliWorkerId("");
    setIsCoordinator(false);
    setRoleMode("none");
    setSelectedRoleId("");
    setCustomPrompt("");
    void Promise.all([
      window.electronAPI.listAgentRoles(),
      window.electronAPI.listBots(),
    ])
      .then(([roleList, botList]) => {
        setRoles(roleList);
        setBots(botList.filter((item) => !item.profile.archivedAt));
      })
      .catch(() => {
        setRoles([]);
        setBots([]);
      });
  }, [open]);

  const enabledChannels = useMemo(
    () => channels.filter((c) => c.enabled),
    [channels],
  );
  const selectedChannel = enabledChannels.find((c) => c.id === channelId);
  const enabledModels = selectedChannel?.models.filter((m) => m.enabled) ?? [];
  const selectedRole = roles.find((r) => r.id === selectedRoleId) ?? null;
  const cliWorkerOptions = cliWorkers?.enabled
    ? cliWorkers.workers.filter((worker) => worker.enabled)
    : [];
  const selectedCliWorker = cliWorkerOptions.find(
    (worker) => worker.id === cliWorkerId,
  );

  const submit = (): void => {
    const name =
      displayName.trim() ||
      (roleMode === "library" && selectedRole ? selectedRole.displayName : "");
    if (!name) return;
    if (backend === "cli" && !selectedCliWorker) return;

    let roleId: string | undefined;
    let roleSnapshot: CollaborationRoleSnapshot | undefined;
    if (!selectedBotId && roleMode === "library" && selectedRole) {
      roleId = selectedRole.id;
      roleSnapshot = {
        roleId: selectedRole.id,
        displayName: selectedRole.displayName,
        description: selectedRole.description,
        systemPrompt: selectedRole.systemPrompt,
      };
    } else if (!selectedBotId && roleMode === "custom" && customPrompt.trim()) {
      roleSnapshot = {
        displayName: name,
        description: "自定义角色",
        systemPrompt: customPrompt.trim(),
      };
    }

    onSave({
      displayName: name,
      channelId: selectedBotId || backend === "cli" ? "" : channelId,
      modelId: selectedBotId || backend === "cli" ? "" : modelId,
      backend: selectedBotId ? "channel" : backend,
      cliWorkerId: selectedBotId || backend !== "cli" ? undefined : cliWorkerId,
      permissionProfile: backend === "cli" ? "workspace-write" : undefined,
      isCoordinator,
      roleId,
      roleSnapshot,
      botProfileId: selectedBotId || undefined,
    });
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          aria-label="添加成员"
          disabled={disabled}
        >
          <UserPlus size={14} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" sideOffset={6} className="w-80">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-foreground">添加成员</h2>
          <span className="text-[11px] text-muted-foreground">
            不选渠道 = 自动（kscc 优先）
          </span>
        </div>

        <label
          className="mt-3 block text-xs text-muted-foreground"
          htmlFor="collab-add-member-name"
        >
          显示名
        </label>
        <Input
          id="collab-add-member-name"
          className="mt-1"
          value={displayName}
          placeholder="例如：开发、测试、文档"
          onChange={(e) => setDisplayName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onOpenChange(false);
            }
          }}
          autoFocus
        />

        <label
          className="mt-3 block text-xs text-muted-foreground"
          htmlFor="collab-add-member-bot"
        >
          Bot（可选）
        </label>
        <Select
          value={selectedBotId || "none"}
          onValueChange={(value) => {
            if (value === "none") {
              setSelectedBotId("");
              setBackend("channel");
              setCliWorkerId("");
              return;
            }
            const bot = bots.find((item) => item.profile.id === value);
            setSelectedBotId(value);
            if (bot) {
              setDisplayName(bot.profile.displayName);
              setRoleMode("none");
              setSelectedRoleId("");
              setCustomPrompt("");
              setBackend("channel");
              setCliWorkerId("");
            }
          }}
        >
          <SelectTrigger id="collab-add-member-bot" className="mt-1">
            <SelectValue placeholder="普通成员（不绑定 Bot）" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">普通成员（不绑定 Bot）</SelectItem>
            {bots.map((bot) => (
              <SelectItem key={bot.profile.id} value={bot.profile.id}>
                {bot.profile.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {selectedBotId ? (
          <p className="mt-1.5 text-xs text-primary">
            将复制该 Bot 当前配置加入房间；角色、渠道和模型以 Bot 版本为准。
          </p>
        ) : null}
        <label
          className="mt-3 block text-xs text-muted-foreground"
          htmlFor="collab-add-member-backend"
        >
          执行后端
        </label>
        <Select
          value={selectedBotId ? "channel" : backend}
          disabled={Boolean(selectedBotId)}
          onValueChange={(value) => {
            const next = value as CollaborationMemberBackend;
            setBackend(next);
            setChannelId("");
            setModelId("");
            if (next !== "cli") setCliWorkerId("");
          }}
        >
          <SelectTrigger id="collab-add-member-backend" className="mt-1">
            <SelectValue placeholder="渠道 / Pi" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="channel">渠道 / Pi</SelectItem>
            {cliWorkerOptions.length > 0 ? (
              <SelectItem value="cli">CLI worker（本机工作区）</SelectItem>
            ) : null}
          </SelectContent>
        </Select>
        {!cliWorkers?.enabled ? (
          <p className="mt-1.5 text-xs text-muted-foreground">
            CLI worker 当前未启用，请先在设置中打开本机 CLI worker 总开关。
          </p>
        ) : cliWorkerOptions.length === 0 ? (
          <p className="mt-1.5 text-xs text-amber-600">
            没有已启用的本机 CLI worker。
          </p>
        ) : null}
        {backend === "cli" && !selectedBotId ? (
          <>
            <label
              className="mt-2 block text-xs text-muted-foreground"
              htmlFor="collab-add-member-cli-worker"
            >
              CLI worker
            </label>
            <Select
              value={cliWorkerId || "none"}
              onValueChange={(value) =>
                setCliWorkerId(value === "none" ? "" : value)
              }
            >
              <SelectTrigger id="collab-add-member-cli-worker" className="mt-1">
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
              CLI worker 会在房间工作区运行并使用
              workspace-write；不会使用这里的渠道/模型选择。
            </p>
          </>
        ) : null}
        <label
          className="mt-3 block text-xs text-muted-foreground"
          htmlFor="collab-add-member-channel"
        >
          内核（渠道）
        </label>
        <Select
          value={channelId || "auto"}
          disabled={Boolean(selectedBotId) || backend === "cli"}
          onValueChange={(v) => {
            setChannelId(v === "auto" ? "" : v);
            setModelId("");
          }}
        >
          <SelectTrigger id="collab-add-member-channel" className="mt-1">
            <SelectValue placeholder="自动（kscc 优先）" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">自动（kscc 优先）</SelectItem>
            {enabledChannels.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {enabledChannels.length === 0 ? (
          <p className="mt-1.5 text-xs text-amber-600">
            没有已启用的渠道，成员将无法回复。请先到设置启用渠道。
          </p>
        ) : null}

        <label
          className="mt-3 block text-xs text-muted-foreground"
          htmlFor="collab-add-member-model"
        >
          模型
        </label>
        <Select
          value={modelId || "default"}
          onValueChange={(v) => setModelId(v === "default" ? "" : v)}
          disabled={
            Boolean(selectedBotId) ||
            backend === "cli" ||
            !channelId ||
            enabledModels.length === 0
          }
        >
          <SelectTrigger id="collab-add-member-model" className="mt-1">
            <SelectValue
              placeholder={
                channelId
                  ? enabledModels.length > 0
                    ? "渠道默认"
                    : "该渠道无可用模型"
                  : "自动时用渠道默认模型"
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

        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            协调者（不 @ 时默认由该成员应答）
          </span>
          <Switch
            size="sm"
            checked={isCoordinator}
            onCheckedChange={setIsCoordinator}
          />
        </div>

        <label
          className="mt-3 block text-xs text-muted-foreground"
          htmlFor="collab-add-member-role"
        >
          角色（可选）
        </label>
        <Select
          value={roleMode === "library" ? selectedRoleId : roleMode}
          disabled={Boolean(selectedBotId) || backend === "cli"}
          onValueChange={(v) => {
            if (v === "none" || v === "custom") {
              setRoleMode(v);
              setSelectedRoleId("");
            } else {
              setRoleMode("library");
              setSelectedRoleId(v);
            }
          }}
        >
          <SelectTrigger id="collab-add-member-role" className="mt-1">
            <SelectValue placeholder="无角色" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">无角色</SelectItem>
            {roles.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.displayName}（{r.id}）
              </SelectItem>
            ))}
            <SelectItem value="custom">自定义角色 prompt…</SelectItem>
          </SelectContent>
        </Select>
        {roleMode === "library" && selectedRole ? (
          <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">
            {selectedRole.description}
          </p>
        ) : null}
        {roleMode === "custom" ? (
          <Textarea
            className="mt-1.5 resize-none"
            rows={3}
            placeholder="输入该成员的角色设定 / 专业能力 prompt"
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
          />
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={
              (!displayName.trim() &&
                !(roleMode === "library" && selectedRole)) ||
              (backend === "cli" && !selectedCliWorker)
            }
            onClick={submit}
          >
            添加
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
