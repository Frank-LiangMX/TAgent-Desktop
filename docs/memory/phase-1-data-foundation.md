# Phase 1：数据层基座

> 双核记忆系统的地基。本 Phase **无行为变化**，纯加字段/路径/配置，为 Phase 3/4 铺路。
> 阻塞关系：1.1 阻塞 Phase 3/4；1.2 阻塞 Phase 4。
> 约束遵守主文档 §5（双写一致性等）。

---

## 1.1 模型配置加 contextWindow + safeContextLimit

### 问题
`ChannelModel`（`packages/shared/src/types/channel.ts` L106-113）只有 `id/name/enabled`，**无窗口字段**。`buildPlaceholderModel`（`pi-agent-adapter.ts` L953-981）硬编码 `contextWindow: 128_000`（L965/L979）。所有模型被当 128k，GLM-5.2 标称 1M（只在 name 字符串 "(1M)"）但代码拿不到。渲染层 `Chat.tsx` L167/L599 又各自 fallback `128_000`，`ContextUsageBadge.tsx` 硬编码 `AUTO_COMPACT_THRESHOLD_RATIO=0.8`（与主进程 `TAGENT_PI_COMPACTION_THRESHOLD_RATIO=0.8` 重复硬编码）。

### 改动

**a. `packages/shared/src/types/channel.ts`（ChannelModel L106-113）加可选字段：**
```ts
export interface ChannelModel {
  id: string
  name: string
  enabled: boolean
  contextWindow?: number      // 模型标称窗口（token），如 200_000 / 1_000_000
  safeContextLimit?: number   // 实测安全上限（爆过自学习回写，Phase 5）；缺省 = contextWindow × 0.7
}
```
可选字段，旧 `channels.json` 反序列化不破坏（缺省走运行时推断）。

**b. `apps/electron/src/main/lib/channel/default-models.ts` 填值：**
- `KSCC_DEFAULT_MODELS`（L13-20）每项加 `contextWindow`：
  - `glm-5.2` → `contextWindow: 1_000_000`（标称 1M；safeContextLimit 由 Phase 5 自学习收敛到 ~256k 量级，初值不填走 0.7×1M=700k 兜底，爆过再回写）
  - `mimo-v2.5` / `mimo-v2.5-pro` → `contextWindow: 1_000_000`
  - `kimi-k2.5` / `kimi-k2.6` / `glm-5.1` → 200_000（用户说 kscc 最少 200k）
- `EXTERNAL_DEFAULT_MODELS`（L26-50）补常见值：anthropic 200k / deepseek 64k / openai 128k 等。

**c. 新建 `apps/electron/src/main/lib/channel/model-window.ts`：**
```ts
// 统一窗口解析，4 处共用（pi-adapter / session-service / 软重置 / 渲染 fallback），避免各自硬编码
export function resolveModelContextWindow(channel: Channel, modelId: string): number
// 优先级：ChannelModel.safeContextLimit > learnedSafeContextLimit(Phase5) > ChannelModel.contextWindow × 0.7 > TAGENT_PI_COMPACTION_FALLBACK_CONTEXT_WINDOW(200k)
```
- 读取 Phase 5 的 `context-limits.json`（自学习回写值），Phase 1 先不读（返回 undefined 走 0.7 兜底）。

**d. `apps/electron/src/main/lib/adapters/pi/pi-agent-adapter.ts` buildPlaceholderModel（L953-981）：**
- 签名加 `contextWindow?: number`：`buildPlaceholderModel(config, contextWindow?)`
- L965/L979 `contextWindow: 128_000` → `contextWindow: contextWindow ?? 128_000`（保留 128k 兜底，优先用传入值）
- 调用点 L562 `buildPlaceholderModel(channelConfig)` → 传入解析的窗口。
- **接线**：`PiExternalChannelConfig`/`PiKsccChannelConfig` 加 `contextWindow?: number`，由 `session-service.ts` 组装 PiQueryOptions 时从 `channel.models.find(m=>m.id===modelId).contextWindow` 取后注入（`resolveModelContextWindow`）。

**e. 渲染层 fallback 对齐（`apps/electron/src/renderer/components/chat/Chat.tsx`）：**
- L167 `applyUsage(usage, contextWindow = 128_000)` → 经 IPC 拿真实值，拿不到 fallback 提常量 `FALLBACK_CONTEXT_WINDOW`，与 `TAGENT_PI_COMPACTION_FALLBACK_CONTEXT_WINDOW` 对齐到 200_000（主进程/渲染层口径一致）。
- L599 `compact_complete` 的 `contextWindow: 128_000` 同改。
- `ContextUsageBadge.tsx` / `TokenStatsBar.tsx` 硬编码 `AUTO_COMPACT_THRESHOLD_RATIO=0.8` → 提到 shared 常量，与主进程 `TAGENT_PI_COMPACTION_THRESHOLD_RATIO` 统一。
- **注意 D10**：kscc 不显示 token 栏（`showTokenBar = lockedKind === 'external'`，L299），本 Phase 不动此判断。

### 复用
- `pi-context-settings.ts` 的 `resolveContextWindow`（L38）已处理缺失兜底，buildPlaceholderModel 改后让 `buildTagentCompactionSettings(model.contextWindow)`（L585）自然读到真实窗口。

### 验证
- 单测 `resolveModelContextWindow`：有 contextWindow / 有 safeContextLimit / 都没有 / 各组合优先级。
- 集成：选 GLM-5.2 发一条，确认 `buildPlaceholderModel` 收到 1M 而非 128k；compaction 阈值按 1M 算（pi 核）。
- 回归：旧 channels.json（无 contextWindow 字段）反序列化不崩，走 200k fallback。

---

## 1.2 JSONL 存储分离（关键，阻塞 Phase 4）

### 问题
`session-store.ts` 的 `appendMessages`（L180）+ `readMessages`（L198）+ `resolveSessionPath`（L171）单一 JSONL 同时服务 SDK resume 和面板历史。`session-service.ts` GET_SDK_MESSAGES（L188）读 `readMessages`，`handleSdkStreamMessage`（L605）同 `appendMessages`。压缩重写 JSONL 会丢面板消息（D5）。General 没分离是因为它只丢工具结果不伤面板；Desktop 做摘要级软重置必须分离。

### 目标
分离两份：
- **SDK JSONL**（`projects/{slug}/{sessionId}.jsonl`，即现有 `getProjectSessionPath`）：SDK resume 用，可压缩/重写/分叉。kscc 落 SDKMessage。
- **面板消息存储**（`projects/{slug}/{sessionId}.messages.jsonl` 新建路径）：只追加，永不压缩。kscc 落 SDKMessage 副本，pi 落 IR 副本。面板历史、L-rag 原文检索、软重置压缩读历史都读这份。

### 改动

**a. `apps/electron/src/main/lib/config/config-paths.ts`：**
- 新增 `getProjectMessagesPath(slug, sessionId)` = `join(getProjectDir(slug), sessionId + '.messages.jsonl')`
- `getProjectSessionPath`（L94-96）语义收窄为"SDK JSONL"，注释更新，路径不变。
- 旧路径 `getAgentSessionMessagesPath`（L70-72）保留，兼容迁移前老会话。

**b. `apps/electron/src/main/lib/agent/session-store.ts`：**
- 拆 `appendMessages`（L180）为两路：
  - `appendSdkMessages(workspaceId, sessionId, messages)` → 写 SDK JSONL
  - `appendPanelMessages(workspaceId, sessionId, messages)` → 写面板消息存储（只追加，永不重写）
- 拆 `readMessages`（L198）：
  - `readSdkMessages(workspaceId, sessionId)` → 读 SDK JSONL（SDK resume 用，软重置压缩读 A 用）
  - `readPanelMessages(workspaceId, sessionId)` → 读面板消息存储（GET_SDK_MESSAGES 改读这份；L-rag 原文检索读这份）
- **兼容**：`readPanelMessages` 不存在时 fallback 读 SDK JSONL（迁移期老会话只有一份）。
- `deleteSessionFiles`（L129）两份都删（含旧路径兜底）。
- 新增 `writeSdkMessages(workspaceId, sessionId, messages)`（全量重写，compactor 用，面板那份没有此方法——只追加）。
- `appendSdkMessages` / `appendPanelMessages` 各自保持原子的 `appendFileSync`。

**c. `apps/electron/src/main/lib/ipc/session-service.ts`：**
- GET_SDK_MESSAGES L188-191：`readMessages(...)` → `readPanelMessages(...)`（面板历史只读只追加那份，不受 SDK JSONL 压缩影响）。
- `handleSdkStreamMessage` L599-605：`appendMessages(workspaceId, sessionId, [msg])` → **双写**：`appendPanelMessages` + `appendSdkMessages`（kscc 落 SDKMessage 两份各一份）。**顺序**：先写面板（保可见），再写 SDK。
- `handlePiStreamPayload` L615-618：`appendMessages(workspaceId, sessionId, [p.message])` → `appendPanelMessages(...)`（pi 只写面板那份；pi 无 SDK resume，但为 L-rag 原文 + 软重置统一，pi 也写面板那份 IR）。
- 首条 user 消息 L370（kscc）/L383（pi）：同样双写或写面板那份。

### 双写一致性（约束 1）
- `handleSdkStreamMessage` 双写两份不同文件，先面板后 SDK。
- 面板写失败 → 仅 `warn`，不阻塞 SDK（面板历史丢一条可接受，用户下次加载少一条）。
- SDK 写失败 → 影响 resume，记 `error` 但不阻塞当轮对话（resume 失败有崩溃恢复兜底）。

### 软重置对两份的影响（Phase 4 细节，此处备位）
- 影子 B 压缩：读 SDK JSONL-A（`readSdkMessages`）→ LLM → 生成 SDK JSONL-B（`shadowSessionId` 文件）。
- 切换时：补尾游标后消息追加到 SDK JSONL-B → `meta.sdkSessionId` 改指 B → A 的 SDK JSONL 归档（rename `.jsonl.archived`）。
- **面板消息存储不动**（一直只追加，跨 A/B 切换无感，用户看到完整历史）——这是分离的核心收益。

### 验证
- 单测：双写后面板份与 SDK 份内容一致；`readPanelMessages` 读面板份；老会话（只有 SDK JSONL）`readPanelMessages` fallback 不崩。
- 集成：kscc 发消息后面板加载完整；模拟压缩重写 SDK JSONL，面板历史不丢。
- 回归：删会话两份都删。

---

## 1.3 AgentSessionMeta 加软重置字段 + 阈值自学习存储

### 改动

**a. `packages/shared/src/types/agent.ts`（AgentSessionMeta L912-1009）加可选字段：**
```ts
// 软重置（Phase 4）
shadowSessionId?: string        // 影子 B 的 SDK session id（压缩生成后填）
shadowState?: 'idle' | 'compacting' | 'ready' | 'switching' | 'switched'  // 影子状态机
shadowCursor?: string           // 拉起 B 时 A 的末尾消息 uuid（切换补尾游标基准）
shadowChainPrev?: string        // 单向链前驱（A→B→C），归档溯源用
// 阈值自学习（Phase 5）
learnedSafeContextLimit?: number // 自学习回写的安全上限
lastBurstTokenCount?: number    // 上次爆点 token 数
```
- 复用已有：`sdkSessionId`（当前主 A）、`resumeAtMessageUuid`（软重置补尾用，字段已定义 L957 未消费）、`forkSourceDir`/`forkSourceSdkSessionId`（fork 用，已定义未消费）。

**b. 阈值自学习存储（Phase 5 实现，此处备位）：**
- per-channel per-model 存 `~/.tagent[-dev]/projects/{slug}/memory/context-limits.json`（`{ [modelId]: { safeLimit, burstCount, lastBurst } }`），复用 `getProjectMemoryDir`（已存在 `config-paths.ts` L99-103）。
- 读取：`resolveModelContextWindow`（1.1 新建）优先级 = `ChannelModel.safeContextLimit` > `learnedSafeContextLimit` > `ChannelModel.contextWindow × 0.7` > fallback(200k)。

### 验证
- 旧 `agent-sessions.json`（无新字段）反序列化不崩。
- `updateSessionMeta` 写新字段后 `getSessionMeta` 读回一致。

---

## Phase 1 完成标准

- [ ] `ChannelModel` 有 `contextWindow`/`safeContextLimit`，`default-models` 填了值
- [ ] `buildPlaceholderModel` 读真实窗口，不再恒 128k
- [ ] `resolveModelContextWindow` 统一解析，4 处共用
- [ ] JSONL 分离：`appendSdkMessages`/`appendPanelMessages`/`readSdkMessages`/`readPanelMessages`/`writeSdkMessages`
- [ ] GET_SDK_MESSAGES 读面板份；handleSdkStreamMessage 双写；handlePiStreamPayload 写面板份
- [ ] `AgentSessionMeta` 加软重置 + 自学习字段
- [ ] 渲染层 fallback 与主进程对齐到 200k
- [ ] 旧数据（无窗口字段/单 JSONL）回归不崩
