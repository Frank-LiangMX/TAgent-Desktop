# Phase 2：全局记忆 L5 移植

> 从 TAgent_General 移植 L0-L5 + Nudge + 空闲批量整理 + Reflect + Cleanup + Self-Repair 到 Desktop。
> 本 Phase 不动双核压缩逻辑，纯移植 + 接线。与 Phase 3/4 可并行，但 **2.4 防线先做**，避免测试时 LLM 乱写记忆。
> 移植源：`/f/TAgent_General/apps/electron/src/main/lib/` 及 `renderer/components/memory/`。

---

## 2.1 7 个 main 服务文件移植 + 启动 wiring

### 移植清单（复制到 `apps/electron/src/main/lib/memory/`）

| 源文件（General） | 目标（Desktop `memory/`） | 改动点 |
|---|---|---|
| `memory-layer-service.ts` | `memory/memory-layer-service.ts` | `getMemoryDir` 改用 Desktop `getConfigDir()`（General 用 `app.getPath('home')/.tagent`，Desktop 已有 `getConfigDir()` 带 dev/packaged 分流，见 `config-paths.ts`）；`getDiscardedMemoryDir` 照搬（`os.tmpdir()`）。L4 db 路径同源改。 |
| `nudge-service.ts` | `memory/nudge-service.ts` | 依赖 memoryLayerService 改相对路径；逻辑照搬（onTurnStart 4 模式 / warm-up[1,2,4,8,10] / 冷却 L0=10/L1=20/L2=10/L3=30 / writeToLayer patch+去重+禁易变状态校验 / L1 ≤30 行）。 |
| `memory-evidence-sink.ts` | `memory/memory-evidence-sink.ts` | pending_evidence.jsonl + dirty_state.json + consumeEvidenceByIds(temp+rename 原子)照搬。 |
| `memory-consolidation-service.ts` | `memory/memory-consolidation-service.ts` | runIfEligible 9 步 + defaultExecutor + defaultApplier 照搬。**LLM 调用**：General 用自有客户端；Desktop 复用 pi-core `createCompactionModelsShim`（`pi-context-compaction.ts` L211 已有）或新建 consolidation 专用 streamFn（用当前会话渠道）。见 2.1 末。 |
| `idle-memory-consolidation-scheduler.ts` | `memory/idle-memory-consolidation-scheduler.ts` | setTimeout 递归 60s 扫描，general/ta 串行，`resolveIdleConsolidationFlag`（dev 开 packaged 关）照搬。 |
| `reflect-service.ts` | `memory/reflect-service.ts` | applyConsolidationInsights（纯本地写 L5+L3）+ 36h 调度照搬。 |
| `scheduled-cleanup-service.ts` | `memory/scheduled-cleanup-service.ts` | 周 cleanup（L4 归档/L3 压缩/FTS5 重建/LRU）照搬。 |
| `self-repair-service.ts` | `memory/self-repair-service.ts` | 月 self-repair（L3 命中率/L5 反向引用/L0 跨模式/月度报告）照搬。 |
| `stage-queue-service.ts` | `memory/stage-queue-service.ts` | 写入门控三态 pending_approval.jsonl 照搬。 |

### 辅助移植（Phase 4 也要用，先放 `memory/`）

| 源文件 | 目标 | 改动 |
|---|---|---|
| `agent-context-utils.ts` | `memory/agent-context-utils.ts` | `setSessionContextWindow`/`getSessionContextWindow`/`computeMaxContextMessages`（Map 缓存）照搬。 |
| `agent-session-compactor.ts` | `memory/agent-session-compactor.ts` | 3 策略 `planDropOldToolResults`(PROTECT_FIRST_N=3/PROTECT_LAST_N=6)/`planKeepLastN`/summarize 照搬。**改读写路径**：General 用 `getAgentSessionMessagesPath`（旧路径）；Desktop 改用 Phase 1.2 的 `readSdkMessages`/`writeSdkMessages`（SDK JSONL，不碰面板那份）。`compactSession` 入参加 `workspaceId`。`summarize` 策略 General 未实现（L253-259），Phase 4 新实现。 |

### consolidation LLM 调用（Desktop 适配点）

General `defaultExecutor` 从 `settings.agentChannelId` 读渠道 + streamSSE。Desktop 适配：
- **方案 A**（推荐）：复用 pi-core `createCompactionModelsShim`（L211）——把 consolidation 的 LLM 请求委托给一个 Models shim，走与主对话相同的 streamFn/apiKey/baseUrl。需把当前会话渠道的 streamFn 传给 ConsolidationService。
- **方案 B**：consolidation 用固定的"便宜渠道"（用户配置一个 cheap model 专做记忆整理）。
- 倾向 A（无需用户额外配置），但需确认 consolidation 请求能拿到当前渠道 streamFn（consolidation 在后台跑，会话可能已切换，需缓存会话渠道信息）。

### 启动 wiring（改 `apps/electron/src/main/index.ts`）

新增（对应 General index.ts L689-728）：
```ts
safeRun('initializeMemoryServices', () => {
  memoryLayerService.initialize()
  scheduledCleanupService.initialize()
  selfRepairService.initialize()
  if (resolveIdleConsolidationFlag(app.isPackaged)) {
    reflectService.initialize(false)  // 空闲整理接管，不另起 LLM 调度
  } else {
    reflectService.initialize()       // 旧机制：每日 03:00
  }
})
await safeAwait('startIdleConsolidationScheduler', async () => {
  if (resolveIdleConsolidationFlag(app.isPackaged)) {
    await startIdleConsolidationScheduler()
  }
})
```
- app.before-quit：`memoryLayerService.close()` + scheduler.stop()。

### 依赖
- **better-sqlite3**：General 已依赖，Desktop `apps/electron/package.json` 需加 + `electron-rebuild`（native 模块）。**R6 风险**：先确认是否已有。
- d3-force / sonner / react-markdown：UI 组件用，见 2.3。

---

## 2.2 agent-prompt-builder 移植 + 双核 memorySnapshot 注入

### 移植
移植 `agent-prompt-builder.ts` → `memory/agent-prompt-builder.ts`：
- `MEMORY_MANAGEMENT_RULES`（General L442-475，禁 LLM 写记忆）照搬。
- `memorySnapshot` 注入段（General L912-930，`## 记忆快照` 段）照搬。
- 导出 `buildMemoryPromptSections({ mode, memorySnapshot })` → `{ managementRules, memorySnapshotSection }` 两段文本，供双核各自拼进 systemPrompt（不整体替换 Desktop 现有 systemPrompt）。

### 双核注入点（关键差异，D8 稳定层进 system）

**pi 核（`pi-agent-adapter.ts`）：**
- 现状 L642 `systemPrompt: systemPrompt ?? DEFAULT_SYSTEM_PROMPT`。
- 改 `createSession`：调 `memoryLayerService.readMemorySnapshot(mode)` + `buildMemoryPromptSections`，两段拼到 systemPrompt 末尾：
  ```ts
  const mem = buildMemoryPromptSections({ mode, memorySnapshot: memoryLayerService.readMemorySnapshot(mode) })
  const fullSystemPrompt = [systemPrompt ?? DEFAULT_SYSTEM_PROMPT, mem.managementRules, mem.memorySnapshotSection].filter(Boolean).join('\n\n')
  ```
- **Frozen 语义**（D1/D8）：memorySnapshot 在 createSession 读一次写死进 systemPrompt，会话内不刷新（保 cache 命中）。L3/L5 按需检索走 messages 区（Phase 3 L-rag）。
- **mode 来源**：`AgentQueryInput` 加 `sessionMode?: 'general'|'ta'`，由 `session-service.ts` 从 `meta.mode` 透传。
- **R7 风险**：pi systemPrompt 整体替换，切渠道重建 Agent 时 createSession 重读 memorySnapshot，同 mode 则 systemPrompt 不变 cache 仍命中。

**kscc 核（`claude-agent-adapter.ts` / `session-service.ts`）：**
- 现状 `KsccQueryOptions.systemPrompt`（L50，string | preset）直传 SDK。
- 改 `session-service.ts` sendMessage 组装 kscc opts（L503-544）时：调 `buildMemoryPromptSections` + `readMemorySnapshot(meta.mode)`，拼到 systemPrompt：
  - 若 preset `claude_code` → `{type:'preset', preset:'claude_code', append: [existing append, mem.managementRules, mem.memorySnapshotSection].join('\n\n')}`
  - 若 string → 拼接末尾。
- 同样 Frozen：首次 spawn 注入一次，长驻会话内不刷新（kscc 长驻进程 systemPrompt 不变，天然保 cache）。

---

## 2.3 IPC + preload + UI 组件移植

### IPC（`apps/electron/src/main/lib/ipc/`，新建 `memory-ipc.ts` 或并入 session-service）

**注册 `MEMORY_IPC_CHANNELS`**（shared 已定义 `types/agent.ts` L14-45）：
- `GET_PENDING_NUDGES` → `nudgeService.getPendingNudges(sessionId)`
- `RESPOND_NUDGE` → `nudgeService.handleNudgeResponse(sessionId, nudgeId, action, mode)`
- `NUDGE_EVENT` → 推送（nudgeService 检出候选 → 经 WebContents 推渲染层）
- `GET_STAGE_QUEUE` / `ACCEPT_STAGE_ALL` / `REJECT_STAGE_ALL` / `ACCEPT_STAGE_ONE` / `REJECT_STAGE_ONE` → stage-queue-service
- `GET_GRAPH_DATA` → `buildGraphPayload(mode, workspaceSlug)`（learning-graph-service，需一并移植）

**注册 `AGENT_IPC_CHANNELS` 记忆相关**（shared L2069+）：
- `INIT_MEMORY_LAYERS` → `memoryLayerService.initialize()`
- `GET_MEMORY_STATS` → `memoryLayerService.getStats(mode)`
- `SEARCH_MEMORY_SESSIONS` → `memoryLayerService.searchSessions(mode, query, limit)`
- `LIST_RECENT_MEMORY_SESSIONS` → `memoryLayerService.listRecentSessions(mode, limit)`
- `GET_MEMORY_MD_CONTENT` → `memoryLayerService.getMdContent(mode, layer)`
- `GET_MEMORY_CORRECTIONS` → `memoryLayerService.getCorrections(mode, limit)`

### preload（`apps/electron/src/preload/index.ts`）
照搬 General preload 暴露（L741-942 实现 + L2428-2490 调用）：
- `electronAPI.initMemoryLayers / getMemoryStats / searchMemorySessions / listRecentMemorySessions / getMemoryMdContent / getMemoryCorrections`
- `electronAPI.getPendingNudges / respondNudge / onNudgeEvent / getStageQueue / acceptStageAll / rejectStageAll / acceptStageOne / rejectStageOne / getGraphData`

### UI 组件（复制到 `apps/electron/src/renderer/components/memory/`）

| 源（General） | 目标（Desktop） | 说明 |
|---|---|---|
| `MemoryMonitorPanel.tsx`（598行，rail-only） | 同名 | 调 `window.electronAPI` + `topLevelModeAtom`。需确认 Desktop renderer 有同款 `topLevelModeAtom`（`@/atoms/app-mode`），否则适配。 |
| `MemoryGraph.tsx`（479行，d3-force） | 同名 | 加 `d3-force`/`d3-scale` 依赖。 |
| `StageQueueCard.tsx`（177行） | 同名 | — |
| `NudgeToast.tsx`（81行，sonner） | 同名 | 全局挂（Chat 顶层），非 rail 组件。确认 Desktop 有 `sonner`。 |

**挂载点**（`apps/electron/src/renderer/components/.../MainArea.tsx`，对应 General MainArea L92-94/L132-133）：
- `activeRailItem === 'memory'` → 渲染 `MemoryMonitorPanel`（内嵌 StageQueueCard + MemoryGraph）。
- NudgeToast 全局挂 Chat 顶层。

**依赖确认**：d3-force / d3-scale（加）、sonner（确认）、react-markdown/remark-gfm（确认）、jotai（已有）、lucide-react（已有）。

---

## 2.4 SDK auto-memory 防线（先做）

### getDiscardedMemoryDir（2.1 移植时保留）
- kscc 核 `buildSdkOptions`（`claude-agent-adapter.ts` L140-191）加 `autoMemoryDirectory: getDiscardedMemoryDir()`。
- SDK 0.3.153 的 `autoMemoryEnabled: false` 是空壳，LLM 仍按 SDK 内置 system prompt 主动 Write memory/，故重定向到 `/tmp/tagent-discarded-memory/` 废目录兜底。
- **R4 风险**：确认 Desktop 用的 `claude-agent-sdk` 版本是否暴露 `autoMemoryDirectory` 选项（General 用 0.3.153；Desktop 查 `apps/electron/package.json`）。不暴露则降级仅靠 `MEMORY_MANAGEMENT_RULES` 反向指令。

### MEMORY_MANAGEMENT_RULES（2.2 已含）
- 双核 systemPrompt 都拼入，反向指令 LLM 不要主动 Write 记忆 .md。
- 双防线（D1）：`getDiscardedMemoryDir` 重定向 + `MEMORY_MANAGEMENT_RULES` 反向指令，缺一不可。

---

## 2.5 nudgeService.onTurnStart + recordSession 接线点

General 在 `agent-orchestrator.ts` L1825-1852 每轮 turn 开始调 `nudgeService.onTurnStart(sessionId, recentMsgs, mode)`，L1678 result 后调 `recordSession`。

### Desktop 双核接线（统一入口，避免两核各自接）

**统一在 `session-service.ts` sendMessage 入口调 `onTurnStart`**（无论双核）：
- `recentMsgs` 用 `readPanelMessages`（Phase 1.2，跨核格式统一见 Phase 5.2）。
- 避免两核各自重复接线。

**recordSession**（会话 result 后）：
- `handleSdkStreamMessage` 检测 `type==='result'` → 调 `memoryLayerService.recordSession`。
- `handlePiStreamPayload` 检测 `kind==='result'` → 同。
- recordSession 参数（title/summary/keyFacts/toolsUsed）从 result/消息流提取。

**会话删除**（General `agent-session-manager.ts:583`）：
- Desktop 删会话时调 `nudgeService.markSessionDeleted(id)`（孤儿引用修复，给 L0/L2/L3/L5 行加 `deleted:1`）。

---

## Phase 2 完成标准

- [ ] 7 个 main 服务 + agent-context-utils + agent-session-compactor 移植到 `memory/`，路径改 `getConfigDir()`
- [ ] compactor 读写改 `readSdkMessages`/`writeSdkMessages`（不碰面板份）
- [ ] `index.ts` memory 服务启动 wiring + quit 清理
- [ ] better-sqlite3 依赖 + electron-rebuild
- [ ] `buildMemoryPromptSections` 导出，双核 systemPrompt 注入（Frozen，保 cache）
- [ ] IPC + preload 记忆通道全注册
- [ ] 4 个 UI 组件移植，挂 MainArea `memory` rail item
- [ ] `autoMemoryDirectory` 重定向 + `MEMORY_MANAGEMENT_RULES` 双防线
- [ ] `onTurnStart`/`recordSession`/`markSessionDeleted` 接线
- [ ] 验证：记忆页可看 L0-L5；Nudge accept 写入 L0-L2 后下会话 systemPrompt 含 `## 记忆快照`；LLM 不写 memory md（防线）；旧会话加载不崩

### Phase 2 验证细节
- **L5 移植**：单测 memoryLayerService schema/FTS5/eager 创建；nudge 4 模式阈值；evidence 原子 consume；consolidation 9 步条件。
- **集成**：记忆页四组件渲染；Nudge toast accept→L0 写入→下会话 Frozen 命中 cache（对比 systemPrompt 前缀不变）。
- **防线**：构造 LLM 想 Write memory/test.md，验证被反向指令拒 + 落 /tmp 废目录。
