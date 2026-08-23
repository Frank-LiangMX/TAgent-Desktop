import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  ArrowsClockwise,
  Brain,
  CircleNotch,
  MagnifyingGlass,
  Plus,
  Robot,
  Sparkle,
  Trash,
} from "@phosphor-icons/react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@tagent/ui";
import type {
  AgentRoleProfile,
  BotConfigRevision,
  BotMemoryRecord,
  BotProfileRecord,
  Channel,
} from "@tagent/shared";
import { cn } from "../../lib/utils";

type BotFormState = {
  displayName: string;
  description: string;
  systemPrompt: string;
  roleId: string;
};

const EMPTY_FORM: BotFormState = {
  displayName: "",
  description: "",
  systemPrompt: "",
  roleId: "",
};

function monogram(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : "?";
}

function slugify(value: string): string {
  const base = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "bot";
}

function formatDate(value: number): string {
  return new Date(value).toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
}

function statusLabel(status: BotProfileRecord["profile"]["status"]): string {
  return status === "active"
    ? "可使用"
    : status === "paused"
      ? "已暂停"
      : status === "archived"
        ? "已归档"
        : "草稿";
}

function buildRecord(
  form: BotFormState,
  role: AgentRoleProfile,
): BotProfileRecord {
  const now = Date.now();
  const id = `${slugify(form.displayName)}-${now.toString(36)}`;
  const revisionId = `${id}-r1`;
  return {
    profile: {
      id,
      ownerUserId: "local-user",
      displayName: form.displayName.trim(),
      description: form.description.trim() || "可在会话中直接调用的 Bot。",
      status: "active",
      currentConfigRevisionId: revisionId,
      memoryNamespace: `bot:local-user:${id}`,
      createdAt: now,
      updatedAt: now,
    },
    revisions: [
      {
        id: revisionId,
        botProfileId: id,
        version: 1,
        backend: "channel",
        roleSnapshot: {
          roleId: role.id,
          displayName: role.displayName,
          description: role.description,
          systemPrompt: form.systemPrompt.trim() || role.systemPrompt,
        },
        permissionProfile: "read-only",
        capabilities: {
          supportsResume: false,
          supportsLiveInput: false,
          supportsToolBridge: false,
          supportsStructuredEvents: false,
        },
        createdAt: now,
        publishedAt: now,
      },
    ],
  };
}

export function BotLibraryView(): JSX.Element {
  const [bots, setBots] = useState<BotProfileRecord[]>([]);
  const [roles, setRoles] = useState<AgentRoleProfile[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [roleQuery, setRoleQuery] = useState("");
  const [form, setForm] = useState<BotFormState>(EMPTY_FORM);
  const [createOpen, setCreateOpen] = useState(false);
  const [detailBot, setDetailBot] = useState<BotProfileRecord | null>(null);
  const [detailMemories, setDetailMemories] = useState<BotMemoryRecord[]>([]);
  const [memoryEvidence, setMemoryEvidence] = useState("");
  const [allowMemoryModel, setAllowMemoryModel] = useState(false);
  const [runtimeChannelId, setRuntimeChannelId] = useState("");
  const [runtimeModelId, setRuntimeModelId] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [botList, roleList, channelList] = await Promise.all([
        window.electronAPI.listBots(),
        window.electronAPI.listAgentRoles(),
        window.electronAPI.listChannels(),
      ]);
      setBots(botList);
      setRoles(roleList);
      setChannels(channelList);
      setForm((current) => ({
        ...current,
        roleId: current.roleId || roleList[0]?.id || "",
      }));
      setDetailBot((previous) => {
        if (!previous) return previous;
        return (
          botList.find((record) => record.profile.id === previous.profile.id) ??
          null
        );
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const filteredBots = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return bots;
    return bots.filter((record) => {
      const { profile } = record;
      return [profile.displayName, profile.id, profile.description ?? ""].some(
        (value) => value.toLowerCase().includes(normalized),
      );
    });
  }, [bots, query]);

  const filteredRoles = useMemo(() => {
    const normalized = roleQuery.trim().toLowerCase();
    if (!normalized) return roles;
    return roles.filter((role) =>
      [role.displayName, role.id, role.description ?? ""].some((value) =>
        value.toLowerCase().includes(normalized),
      ),
    );
  }, [roles, roleQuery]);

  const openDetail = async (record: BotProfileRecord) => {
    setDetailBot(record);
    setMemoryEvidence("");
    setAllowMemoryModel(false);
    const revision = record.revisions.find(
      (item) => item.id === record.profile.currentConfigRevisionId,
    );
    setRuntimeChannelId(revision?.channelId ?? "");
    setRuntimeModelId(revision?.modelId ?? "");
    try {
      setDetailMemories(
        await window.electronAPI.listBotMemories(record.profile.id),
      );
    } catch (cause) {
      setDetailMemories([]);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const enabledChannels = channels.filter((channel) => channel.enabled);
  const selectedRuntimeChannel = enabledChannels.find(
    (channel) => channel.id === runtimeChannelId,
  );
  const runtimeModels =
    selectedRuntimeChannel?.models.filter((model) => model.enabled) ?? [];
  const activeDetailRevision = detailBot?.revisions.find(
    (revision) => revision.id === detailBot.profile.currentConfigRevisionId,
  );
  const runtimeSummary = runtimeChannelId
    ? `${selectedRuntimeChannel?.name ?? runtimeChannelId} · ${runtimeModelId || "渠道默认模型"}`
    : "跟随使用它的会话";

  const publishRuntimeConfig = async (): Promise<void> => {
    if (!detailBot || !activeDetailRevision) return;
    if (runtimeModelId && !runtimeChannelId) {
      setError("指定模型前请先选择渠道；否则请使用跟随会话");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const now = Date.now();
      const nextVersion =
        Math.max(...detailBot.revisions.map((revision) => revision.version)) +
        1;
      const revision: BotConfigRevision = {
        ...activeDetailRevision,
        id: `${detailBot.profile.id}-r${nextVersion}`,
        version: nextVersion,
        channelId: runtimeChannelId || undefined,
        modelId: runtimeModelId || undefined,
        createdAt: now,
        publishedAt: now,
      };
      const updated = await window.electronAPI.publishBotConfigRevision({
        profileId: detailBot.profile.id,
        revision,
      });
      setBots((current) =>
        current.map((item) =>
          item.profile.id === updated.profile.id ? updated : item,
        ),
      );
      setDetailBot(updated);
      const nextRevision = updated.revisions.find(
        (item) => item.id === updated.profile.currentConfigRevisionId,
      );
      setRuntimeChannelId(nextRevision?.channelId ?? "");
      setRuntimeModelId(nextRevision?.modelId ?? "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const saveNewBot = async () => {
    const displayName = form.displayName.trim();
    if (!displayName) {
      setError("请填写 Bot 名称");
      return;
    }
    const role = roles.find((item) => item.id === form.roleId) ?? roles[0];
    if (!role) {
      setError("角色库为空，暂时无法创建 Bot");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const record = buildRecord({ ...form, displayName }, role);
      const created = await window.electronAPI.createBot({ record });
      setBots((current) => [...current, created]);
      setForm(EMPTY_FORM);
      setCreateOpen(false);
      setDetailMemories([]);
      setDetailBot(created);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const archiveBot = async (record: BotProfileRecord) => {
    if (
      !confirm(
        `归档 Bot「${record.profile.displayName}」？归档不会删除它的配置和记忆。`,
      )
    )
      return;
    setBusy(true);
    try {
      const archived = await window.electronAPI.archiveBot(record.profile.id);
      setBots((current) =>
        current.map((item) =>
          item.profile.id === archived.profile.id ? archived : item,
        ),
      );
      setDetailBot(archived);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const consolidateMemory = async (): Promise<void> => {
    if (!detailBot || !memoryEvidence.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.consolidateBotMemory({
        botProfileId: detailBot.profile.id,
        ownerUserId: detailBot.profile.ownerUserId,
        sourceSurface: "user-note",
        sourceReferenceId: "bot-library-note",
        evidence: memoryEvidence,
        allowModelProcessing: allowMemoryModel,
      });
      setDetailMemories((current) => [...current, ...result.created]);
      setMemoryEvidence("");
      setAllowMemoryModel(false);
      if (result.warning) setError(result.warning);
      if (result.created.length === 0 && result.skipped.length > 0) {
        setError("没有新增候选记忆：内容可能与现有记忆重复。");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const activateMemory = async (memory: BotMemoryRecord) => {
    setBusy(true);
    try {
      const active = await window.electronAPI.activateBotMemory(memory.id);
      setDetailMemories((current) =>
        current.map((item) => (item.id === active.id ? active : item)),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bots-library">
      <header className="roles-shell__header-card bots-library__header">
        <div>
          <h2 className="settings-page-intro-title">Bot 库</h2>
          <p className="settings-page-intro-desc" style={{ marginTop: 6 }}>
            配置一次，之后可以直接加入普通会话或融合会话。Bot
            的房间成员是它在当时配置的副本。
          </p>
        </div>
        <div className="roles-shell__actions">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || loading}
            onClick={() => void reload()}
            aria-label="刷新 Bot"
          >
            <ArrowsClockwise
              className={cn("size-3.5", loading && "animate-spin")}
              weight="bold"
            />
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              setRoleQuery("");
              setCreateOpen(true);
            }}
          >
            <Plus className="mr-1.5 size-3.5" weight="bold" />
            新建 Bot
          </Button>
        </div>
      </header>

      {error ? (
        <div className="roles-shell__error" role="alert">
          {error}
        </div>
      ) : null}

      <div className="roles-toolbar">
        <div className="roles-search">
          <Robot className="roles-search__icon" weight="bold" aria-hidden />
          <input
            type="search"
            className="roles-search__input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索 Bot"
            aria-label="搜索 Bot"
          />
        </div>
        <span className="roles-store-meta">{filteredBots.length} 个 Bot</span>
      </div>

      {loading ? (
        <div className="roles-empty">
          <CircleNotch className="size-4 animate-spin" aria-hidden />
          加载中
        </div>
      ) : filteredBots.length === 0 ? (
        <div className="roles-empty">
          <Robot className="size-8 opacity-30" weight="thin" aria-hidden />
          <span>
            {query ? "没有匹配 Bot" : "还没有 Bot，先配置一个数字员工"}
          </span>
          {!query ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setRoleQuery("");
                setCreateOpen(true);
              }}
            >
              新建 Bot
            </Button>
          ) : null}
        </div>
      ) : (
        <ul className="roles-card-grid">
          {filteredBots.map((record) => {
            const revision =
              record.revisions.find(
                (item) => item.id === record.profile.currentConfigRevisionId,
              ) ?? record.revisions.at(-1);
            return (
              <li key={record.profile.id} className="relative">
                <button
                  type="button"
                  className="roles-card bots-card"
                  onClick={() => void openDetail(record)}
                >
                  <div className="roles-card__top">
                    <span
                      className="roles-avatar bots-card__avatar"
                      aria-hidden
                    >
                      {monogram(record.profile.displayName)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <h3 className="roles-card__title">
                        {record.profile.displayName}
                      </h3>
                      <div className="roles-card__meta">
                        <span className="roles-badge">
                          {statusLabel(record.profile.status)}
                        </span>
                        <span className="roles-badge">
                          v{revision?.version ?? 1}
                        </span>
                        <span className="roles-badge">长期记忆</span>
                      </div>
                    </div>
                  </div>
                  <p className="roles-card__desc">
                    {record.profile.description || record.profile.id}
                  </p>
                  <div className="roles-card__foot">
                    <span className="truncate">
                      {revision?.roleSnapshot.displayName ?? "未绑定角色"}
                    </span>
                    <span className="roles-card__foot-hint">查看 Bot</span>
                  </div>
                </button>
                {record.profile.status !== "archived" ? (
                  <button
                    type="button"
                    className="roles-card__pin bots-card__archive"
                    onClick={(event) => {
                      event.stopPropagation();
                      void archiveBot(record);
                    }}
                    disabled={busy}
                    aria-label={`归档 ${record.profile.displayName}`}
                    title="归档 Bot"
                  >
                    <Archive weight="bold" aria-hidden />
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) setRoleQuery("");
        }}
      >
        <DialogContent className="roles-dialog roles-dialog--create session-glass-modal w-[clamp(420px,44vw,680px)] gap-0 overflow-hidden p-0 sm:max-w-none">
          <div className="roles-dialog__head border-b border-border/50">
            <DialogTitle className="text-base font-semibold tracking-tight">
              新建 Bot
            </DialogTitle>
            <DialogDescription className="mt-1 text-xs text-muted-foreground">
              先配置身份和岗位；模型与渠道可在创建后从 Bot
              详情的“运行配置”中调整。
            </DialogDescription>
          </div>
          <div className="roles-dialog-body bots-form">
            <div className="bots-form__field">
              <Label htmlFor="bot-display-name">名称</Label>
              <Input
                id="bot-display-name"
                value={form.displayName}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    displayName: event.target.value,
                  }))
                }
                placeholder="例如：研究助手"
                autoFocus
              />
            </div>
            <div className="bots-form__field bots-form__field--roles">
              <Label id="bot-role-label">库中角色卡</Label>
              <div className="bots-role-picker" role="group" aria-labelledby="bot-role-label">
                <div className="relative">
                  <MagnifyingGlass
                    className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                    weight="bold"
                    aria-hidden
                  />
                  <Input
                    className="bots-role-picker__search pl-8"
                    value={roleQuery}
                    onChange={(event) => setRoleQuery(event.target.value)}
                    placeholder="搜索角色卡名称…"
                    disabled={roles.length === 0}
                    aria-label="搜索库中角色卡"
                  />
                </div>
                {filteredRoles.length === 0 ? (
                  <p className="bots-role-picker__empty">
                    {roles.length === 0 ? "还没有可用角色卡" : "没有匹配的角色卡"}
                  </p>
                ) : (
                  <ul className="bots-role-picker__list scrollbar-thin" role="listbox" aria-label="库中角色卡">
                    {filteredRoles.map((role) => {
                      const selected = form.roleId === role.id;
                      return (
                        <li key={role.id}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={selected}
                            data-selected={selected || undefined}
                            className="bots-role-picker__card"
                            disabled={busy}
                            onClick={() =>
                              setForm((current) => ({
                                ...current,
                                roleId: role.id,
                              }))
                            }
                          >
                            <span className="bots-role-picker__avatar" aria-hidden>
                              {monogram(role.displayName)}
                            </span>
                            <span className="bots-role-picker__copy">
                              <span className="bots-role-picker__name">
                                {role.displayName}
                              </span>
                              {role.description ? (
                                <span className="bots-role-picker__desc">
                                  {role.description}
                                </span>
                              ) : null}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
              <span className="bots-form__hint">
                角色卡决定岗位身份；Bot 可以在此基础上拥有自己的长期配置。
              </span>
            </div>
            <div className="bots-form__field">
              <Label htmlFor="bot-description">一句话说明</Label>
              <Input
                id="bot-description"
                value={form.description}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
                placeholder="它擅长什么？"
              />
            </div>
            <div className="bots-form__field">
              <Label htmlFor="bot-system-prompt">个性补充（可选）</Label>
              <Textarea
                id="bot-system-prompt"
                value={form.systemPrompt}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    systemPrompt: event.target.value,
                  }))
                }
                placeholder="对这个 Bot 的工作方式、输出习惯做补充"
                rows={5}
              />
              <span className="bots-form__hint">
                角色卡仍负责岗位能力；这里保存的是这个 Bot 的长期配置。
              </span>
            </div>
          </div>
          <div className="roles-dialog__foot flex items-center justify-end gap-2 border-t border-border/50">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setCreateOpen(false)}
            >
              取消
            </Button>
            <Button
              size="sm"
              disabled={busy || !form.displayName.trim() || !form.roleId}
              onClick={() => void saveNewBot()}
            >
              创建 Bot
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={detailBot != null}
        onOpenChange={(open) => {
          if (!open) setDetailBot(null);
        }}
      >
        <DialogContent className="roles-dialog session-glass-modal w-[clamp(460px,48vw,760px)] gap-0 overflow-hidden p-0 sm:max-w-none">
          {detailBot ? (
            <>
              <div className="roles-dialog__head border-b border-border/50">
                <DialogTitle className="text-base font-semibold tracking-tight flex items-center gap-2">
                  <Sparkle
                    className="size-4 text-primary"
                    weight="fill"
                    aria-hidden
                  />
                  {detailBot.profile.displayName}
                </DialogTitle>
                <DialogDescription className="mt-1 font-mono text-[11.5px] text-muted-foreground">
                  {detailBot.profile.id} ·{" "}
                  {statusLabel(detailBot.profile.status)} · 创建于{" "}
                  {formatDate(detailBot.profile.createdAt)}
                </DialogDescription>
              </div>
              <div className="roles-dialog-body bots-detail-body scrollbar-thin">
                <div className="bots-detail-hero">
                  <span
                    className="roles-dialog-identity__avatar bots-card__avatar"
                    aria-hidden
                  >
                    {monogram(detailBot.profile.displayName)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="roles-dialog-identity__title">
                      可加入会话的数字员工
                    </p>
                    <p className="roles-dialog-identity__desc">
                      {detailBot.profile.description}
                    </p>
                  </div>
                </div>
                <div className="roles-stats">
                  <div className="roles-stat">
                    <span className="roles-stat__label">当前版本</span>
                    <span className="roles-stat__value">
                      v
                      {detailBot.revisions.find(
                        (item) =>
                          item.id === detailBot.profile.currentConfigRevisionId,
                      )?.version ?? 1}
                    </span>
                  </div>
                  <div className="roles-stat">
                    <span className="roles-stat__label">角色</span>
                    <span className="roles-stat__value">
                      {detailBot.revisions.find(
                        (item) =>
                          item.id === detailBot.profile.currentConfigRevisionId,
                      )?.roleSnapshot.displayName ?? "未绑定"}
                    </span>
                  </div>
                  <div className="roles-stat">
                    <span className="roles-stat__label">记忆</span>
                    <span className="roles-stat__value">
                      {
                        detailMemories.filter(
                          (memory) => memory.state === "active",
                        ).length
                      }{" "}
                      条已生效
                    </span>
                  </div>
                </div>
                <section
                  className="bots-runtime-panel"
                  aria-labelledby="bot-runtime-title"
                >
                  <div className="bots-runtime-panel__head">
                    <div>
                      <h3 id="bot-runtime-title">运行配置</h3>
                      <p>
                        决定这个 Bot
                        自己使用的渠道和模型；不配置时跟随打开它的会话。
                      </p>
                    </div>
                    <span className="bots-runtime-panel__summary">
                      {runtimeSummary}
                    </span>
                  </div>
                  <div className="bots-runtime-grid">
                    <div className="bots-runtime-field">
                      <label htmlFor="bot-runtime-channel">渠道</label>
                      <Select
                        value={runtimeChannelId || "follow"}
                        disabled={
                          busy || detailBot.profile.status === "archived"
                        }
                        onValueChange={(value) => {
                          setRuntimeChannelId(value === "follow" ? "" : value);
                          setRuntimeModelId("");
                        }}
                      >
                        <SelectTrigger id="bot-runtime-channel">
                          <SelectValue placeholder="跟随使用它的会话" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="follow">
                            跟随使用它的会话
                          </SelectItem>
                          {enabledChannels.map((channel) => (
                            <SelectItem key={channel.id} value={channel.id}>
                              {channel.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="bots-runtime-field">
                      <label htmlFor="bot-runtime-model">模型</label>
                      <Select
                        value={runtimeModelId || "default"}
                        disabled={
                          busy ||
                          detailBot.profile.status === "archived" ||
                          !runtimeChannelId ||
                          runtimeModels.length === 0
                        }
                        onValueChange={(value) =>
                          setRuntimeModelId(value === "default" ? "" : value)
                        }
                      >
                        <SelectTrigger id="bot-runtime-model">
                          <SelectValue
                            placeholder={
                              runtimeChannelId ? "渠道默认模型" : "跟随会话模型"
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="default">渠道默认模型</SelectItem>
                          {runtimeModels.map((model) => (
                            <SelectItem key={model.id} value={model.id}>
                              {model.name || model.id}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="bots-runtime-panel__foot">
                    <span>
                      {enabledChannels.length === 0
                        ? "没有已启用渠道；当前只能跟随会话。"
                        : "保存后会发布新的 Bot 配置版本，已加入房间的成员副本不受影响。"}
                    </span>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy || detailBot.profile.status === "archived"}
                      onClick={() => void publishRuntimeConfig()}
                    >
                      发布新版本
                    </Button>
                  </div>
                </section>{" "}
                <section
                  className="bots-memory-panel"
                  aria-labelledby="bot-memory-title"
                >
                  <div className="bots-memory-panel__head">
                    <div>
                      <h3 id="bot-memory-title">
                        <Brain
                          className="mr-1.5 inline size-4"
                          weight="duotone"
                        />
                        长期记忆
                      </h3>
                      <p>
                        候选记忆不会自动进入 Bot 的 prompt，确认后才会生效。
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 rounded-xl border border-border/50 bg-muted/20 p-3">
                    <Textarea
                      value={memoryEvidence}
                      onChange={(event) =>
                        setMemoryEvidence(event.target.value)
                      }
                      placeholder="把你确认过的笔记交给这个 Bot 整理…（不会自动进入 prompt）"
                      className="min-h-[72px] resize-y border-border/60 bg-background/40 text-xs leading-relaxed"
                      disabled={busy || detailBot.profile.status === "archived"}
                    />
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={allowMemoryModel}
                          onChange={(event) =>
                            setAllowMemoryModel(event.target.checked)
                          }
                          disabled={
                            busy || detailBot.profile.status === "archived"
                          }
                        />
                        允许模型精炼（会发送这段笔记）
                      </label>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={
                          busy ||
                          !memoryEvidence.trim() ||
                          detailBot.profile.status === "archived"
                        }
                        onClick={() => void consolidateMemory()}
                      >
                        整理为候选
                      </Button>
                    </div>
                  </div>
                  {detailMemories.length === 0 ? (
                    <p className="bots-memory-panel__empty">还没有记忆。</p>
                  ) : (
                    <ul className="bots-memory-list">
                      {detailMemories.map((memory) => (
                        <li key={memory.id} className="bots-memory-item">
                          <div>
                            <span
                              className={cn(
                                "roles-badge",
                                `bots-memory-item__state--${memory.state}`,
                              )}
                            >
                              {memory.state === "active"
                                ? "已生效"
                                : memory.state === "candidate"
                                  ? "待确认"
                                  : memory.state === "rejected"
                                    ? "已拒绝"
                                    : "已归档"}
                            </span>
                            <p>{memory.text}</p>
                          </div>
                          {memory.state === "candidate" ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={busy}
                              onClick={() => void activateMemory(memory)}
                            >
                              确认
                            </Button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>
              <div className="roles-dialog__foot flex items-center justify-between gap-2 border-t border-border/50">
                {detailBot.profile.status !== "archived" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    disabled={busy}
                    onClick={() => void archiveBot(detailBot)}
                  >
                    <Trash className="mr-1 size-3.5" weight="bold" />
                    归档
                  </Button>
                ) : (
                  <span className="roles-dialog__foot-hint text-[12px] text-muted-foreground">
                    已归档，历史配置仍保留
                  </span>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setDetailBot(null)}
                >
                  关闭
                </Button>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
