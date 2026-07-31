# 双核上下文管理 + 全局记忆系统 — 主设计文档

> 本文档是 **TAgent_General 2.0 重构（TAgent-Desktop）** 的记忆系统总设计。
> 按 `[用户要求]` 拆成多份文档、详细、标注清楚，便于出问题回溯。
> 本文件是**总览与索引**，各阶段细节见同目录子文档。

---

## 0. 文档结构

> 正式目录：`docs/memory/`（自 `.context/` 整理迁入，2026-08-01）。

| 文档 | 内容 | 状态 |
|---|---|---|
| `master-design.md`（本文件） | 总览、架构、阶段索引、跨阶段约束、风险登记 | 主 |
| `phase-1-data-foundation.md` | 数据层基座：模型配置窗口字段 + JSONL 存储分离 + meta 软重置字段 | 已落地 |
| `phase-2-global-l5-port.md` | 全局记忆 L5 从 General 移植（服务 + prompt 注入 + IPC + UI + 防线） | 已落地 |
| `phase-3-pi-8k-coordinator.md` | pi 核会话内 8k 四层协调器 + L-rag（跨会话+本会话） | 已落地 |
| `phase-4-kscc-soft-reset.md` | kscc resume 核软重置（双 session A/B 状态机 + 原子切换 + 爆了兜底） | 已落地 |
| `phase-5-polish.md` | 阈值自学习 + 跨核格式统一 + 页面增强 + 验证 | 已落地（基础） |
| `handoff.md` | 交接与完成清单 / 验证命令 / 后续增强 | 持续更新 |
| `archive/` | 开发期任务 brief / 移植结果（可清） | 归档 |

---

## 1. 背景与动机（为什么做）

TAgent-Desktop 是 TAgent_General 的 2.0 重构（切 pi 内核）。General 有一套成熟的 5 层全局记忆（L0-L5）+ kscc 客户端压缩，但 Desktop 还没移植，且现状有四个痛点：

1. **pi 核 contextWindow 硬编码**：`buildPlaceholderModel`（`pi-agent-adapter.ts` L965/L979）写死 128k，模型配置无窗口字段，所有模型被当 128k。
2. **kscc resume 核爆上下文直接死**：`session-runtime.ts` L184-245 命中过长即 `state='closed'`，无恢复。用户实测 GLM-5.2 标称 1M 但 256k 就爆，SDK auto-compact 对 GLM 不生效。
3. **kscc 核无上下文管理**：无 compactor、无 `resumeSessionAt`/`forkSession`/`onContextWindow`（`KsccQueryOptions` L32-65 只有 `resumeSessionId`）。General 有这套（100 轮不爆），Desktop 全砍了。
4. **无会话内分层调度**：8k 视频那套"四层预算 + 滚动压缩 + 按需检索"思路未落地。Desktop 会话内只有 pi 核整体摘要压缩。

**目标**：借重构机会，把"会话内 8k 上下文调度"和"全局磁盘记忆"融合重设计。L5 管"记什么到磁盘"（跨会话沉淀），8k 管"当前会话窗口搬什么进来"（实时调度），前者是后者的 RAG 数据源。

---

## 2. 核心设计决策（用户已拍板，不再质疑）

| # | 决策 | 出处 |
|---|---|---|
| D1 | **全局记忆 L5** 从 General 移植 L0-L5 + Nudge + 空闲批量整理 + Reflect + Cleanup + Self-Repair。L0/L1/L2 固定注入 system prompt（会话内冻结保 cache），L3/L5 按需检索。页面照搬 General MemoryMonitorPanel 等。 | 用户确认 |
| D2 | **会话内 8k 四层**：L-short（最近原文）/ L-mid（滚动摘要）/ L-rag（按需检索 L4/L2/L5）/ L-fact（=L0/L2 固定注入）。压缩接管为"分流提取"（事实→L5、要点→L-mid、原文→可检索），不是单纯缩短。 | 用户确认 |
| D3 | **pi 核**：8k 协调器接入 `transformContext`，每轮按四层预算重组 messages，比例自适应 contextWindow。压缩异步不阻塞。 | 用户确认 |
| D4 | **kscc resume 核**：走"软重置"双 session 模型（主 A + 影子 B）。A 到阈值拉 B 后台压缩（不阻塞 A），到切换点原子切换，B 转正成新 A，下次拉新影子。单向链 A→B→C。用户无感（同一 TAgent sessionId）。 | 用户确认 |
| D5 | **JSONL 存储分离**：现状 JSONL 既是 SDK resume 源又是面板历史源，压缩会让面板丢消息。分离成 SDK JSONL（可压缩重写）+ 面板消息存储（只追加永不压缩）。General 没分离是因为它只丢工具结果不伤面板；Desktop 做摘要级软重置必须分离。 | 用户确认 |
| D6 | **模型配置加字段**：`ChannelModel` 加 `contextWindow` + `safeContextLimit`。`buildPlaceholderModel` 读真实窗口，去 128k 硬编码。 | 用户确认 |
| D7 | **软重置切换同步等**：切换那一轮用户等几秒（显示"正在整理记忆"），压缩本身后台跑不阻塞。不搞异步切换。 | 用户确认 |
| D8 | **prompt cache 顺应**：pi-ai Anthropic 适配器自动在 system 末尾 + 最后一条 user 加 `cache_control` 断点。L-fact/L0-L2 进 system（稳定命中 cache），L-mid/L-rag/L-short 进 messages 区（滚动，本就断 cache）。 | 用户确认 |
| D9 | **软重置 B 诞生方式**：先按降级方案——切换时新开 query + 上下文回填（复用 General `prepareResumeFallbackRecovery` 路径），不赌 SDK 预写 uuid。实测 SDK resume 机制后可升级。 | 用户拍板（AskUserQuestion） |
| D10 | **kscc 不加 token 栏**：kscc 上下文获取不准（一两轮就爆、token 估算不准），不给 kscc 加占用环显示，避免误导。**【重要约束】** 软重置触发不能依赖精确 token，改用消息数 + 粗估 + 爆了兜底。 | 用户拍板（AskUserQuestion） |
| D11 | **L-rag 范围**：跨会话（L4 FTS5）+ 本会话（已被压出窗口的旧轮原文，需新增本会话向量存储）都做。 | 用户拍板（AskUserQuestion） |

> **D10 是对早期讨论的修正**：前面提的"45%/60%/75% × safeContextLimit"阈值逻辑依赖精确 token，kscc token 不准则不适用。kscc 软重置触发改用：消息轮次计数 + 字符量粗估 + 爆了兜底（见 Phase 4 文档）。pi 核 token 估算相对准（pi 自管 state.messages），仍用比例阈值。

---

## 3. 总体架构

```
全局记忆 L5（磁盘，后台写，前台只读）= 移植 General
  L0 用户画像 ┐
  L1 项目画像 ├ 固定注入 system prompt（冻结，命中 cache）— D1/D8
  L2 稳定事实 ┘
  L3 纠错（JSONL，按需检索）
  L4 历史会话（SQLite + FTS5，按需检索）─ L-rag 跨会话源 — D11
  L5 提炼洞察（MD，按需检索）─ L-rag 源 — D11
  写入：Nudge→evidence sink→空闲批量整理（一次 LLM 出 4 字段）→stage queue/纯本地写
  维护：周 cleanup / 月 self-repair

会话内 8k（内存，每轮滚）= 新做
  ┌─ pi 核（D3）：transformContext → coordinator.reconcile 每轮重组 messages
  │   L-fact  = L0/L2（已在 system，冻结）
  │   L-short = 尾部原文（预算 80%，自适应）
  │   L-mid   = 滚动递归摘要（12%，链式 previousSummary）
  │   L-rag   = 检索 L4/L2/L5 + 本会话向量（8%，命中注入 messages 头部）
  │   压缩异步不阻塞；过长 force 压缩同步救场
  │
  └─ kscc resume 核（D4）：软重置双 session
      主 A（长驻 resume）→ 阈值拉影子 B（后台压缩读 JSONL-A → LLM → JSONL-B + 抽事实进 L5）
      → 切换点原子切到 B（补尾 + 新 query 上下文回填，D9 降级方案）→ A 归档
      → B 转正成新 A，下次拉新影子 C。单向链。
      三层递进：廉价清理（drop_old_tool_results）→ 拉影子压缩 → 切换
      爆了兜底：不直接 closed，移植 General preparePromptTooLongRecovery 救一次

存储分离（D5）：
  SDK JSONL（projects/{slug}/{id}.jsonl）       — 可压缩重写，SDK resume 用
  面板消息存储（projects/{slug}/{id}.messages.jsonl）— 只追加，面板/L-rag 原文用
```

**两套衔接**：L5 全局记忆是 8k 的 L-rag 检索源（L4 FTS5 + L2/L5 MD）。L5 管"沉淀到磁盘"，8k 管"当前窗口搬什么"，前者是后者的数据源。

---

## 4. 阶段划分与依赖

```
Phase 1 数据层基座（无行为变化，纯地基）
  1.1 模型配置加 contextWindow/safeContextLimit
  1.2 JSONL 存储分离（SDK 可压 vs 面板只追加）  ← 阻塞 Phase 4
  1.3 AgentSessionMeta 加软重置字段 + 阈值自学习存储位

Phase 2 全局记忆 L5 移植（从 General 搬，不动双核压缩）
  2.1 7 个 main 服务 + 启动 wiring
  2.2 agent-prompt-builder + 双核 memorySnapshot 注入
  2.3 IPC + preload + UI 组件
  2.4 SDK auto-memory 防线（先做，避免测试时 LLM 乱写）

Phase 3 pi 核 8k 协调器（依赖 1.1 + 2.2）
  3.1 session-memory-coordinator 新建（四层预算 + cache 断点）
  3.2 transformContext 接入（滚动 L-mid + 异步压缩 + 分流提取）
  3.3 L-rag 检索（L4 FTS5 + L2/L5 + 本会话向量，D11）

Phase 4 kscc resume 核软重置（依赖 1.2 + 1.3 + 2.1）
  4.1 compactor + agent-context-utils 移植 + 透传补全
  4.2 双 session 状态机 + 影子拉起 + 后台压缩
  4.3 原子切换协议（D9 降级方案）+ 爆了兜底
  4.4 廉价清理触发

Phase 5 阈值自学习 + 跨核格式统一 + 页面增强 + 验证
```

**依赖**：1.1 阻塞 3/4；1.2 阻塞 4；2.4 防线先做；3 依赖 1.1+2.2；4 依赖 1.2+1.3+2.1；2 与 3/4 可并行；5 收尾。

**推荐开发顺序**：Phase 1（全部）→ Phase 2.4（防线）+ Phase 2.1/2.2（移植+注入）→ Phase 2.3（UI）→ Phase 3 → Phase 4 → Phase 5。

---

## 5. 跨阶段约束（所有 Phase 遵守）

1. **双写一致性**（D5）：`handleSdkStreamMessage` 双写两份不同文件，先写面板（保可见）再写 SDK；面板写失败仅 warn，SDK 写失败才影响 resume。
2. **切换原子性**（D7/D9）：补尾→新 query 上下文回填→`meta.sdkSessionId` 改指→A 归档，temp+rename 原子，失败回滚（spawn 失败不归档 A）。
3. **cache 命中**（D8）：L-fact/L0-L2 进 system 稳定；L-rag 命中缓存 + 放 messages 最头部（变动只影响其后，尾部最新 user 仍命中 cache）。
4. **SDK auto-memory 防线**（D1）：`getDiscardedMemoryDir` 重定向 + `MEMORY_MANAGEMENT_RULES` 反向指令双防线，缺一不可。
5. **kscc 不显 token**（D10）：软重置触发用消息数 + 粗估 + 爆了兜底，不依赖精确 token；不给 kscc 加 token 栏。
6. **跨核格式**：面板消息存储是统一源；`history-normalizer`（Phase 5）只处理完整消息，不处理流式 delta。

---

## 6. 风险登记

| # | 风险 | 对策 | 归属 Phase |
|---|---|---|---|
| R1 | 双写冲突 | 压缩不写 A 只生成 B，A 只追加；两份不同文件 | 1.2/4 |
| R2 | 切换原子性 | temp+rename + 回滚（spawn 失败不归档 A） | 4.3 |
| R3 | cache 命中 | L-rag 缓存 + 放最头部，尾部 user 命中 | 2.2/3.3 |
| R4 | SDK auto-memory 选项版本依赖 | 不暴露则降级仅靠反向指令 | 2.4 |
| R5 | SDK resume 机制（预写 uuid） | D9 已定降级方案：新 query + 上下文回填 | 4.2 |
| R6 | better-sqlite3 native 重建 | package.json 加依赖 + electron-rebuild | 2.1 |
| R7 | pi systemPrompt 整体替换切渠道 | createSession 重读 memorySnapshot，同 mode cache 仍命中 | 2.2 |
| R8 | kscc token 估算不准 | D10：用消息数 + 粗估 + 爆了兜底，不显 token 栏 | 4 |
| R9 | 本会话向量存储成本 | D11：长会话才建，短会话跳过 | 3.3 |

---

## 7. Critical Files（跨 Phase）

**改动**：
- `packages/shared/src/types/channel.ts` — ChannelModel 加窗口字段（1.1）
- `packages/shared/src/types/agent.ts` — AgentSessionMeta 加软重置字段（1.3）
- `apps/electron/src/main/lib/agent/session-store.ts` — JSONL 存储分离（1.2）
- `apps/electron/src/main/lib/config/config-paths.ts` — 加面板消息路径（1.2）
- `apps/electron/src/main/lib/adapters/pi/pi-agent-adapter.ts` — buildPlaceholderModel 读真实窗口 + transformContext 接 coordinator + memorySnapshot 注入（1.1/3.2/2.2）
- `apps/electron/src/main/lib/adapters/claude/claude-agent-adapter.ts` — KsccQueryOptions 透传补全 + autoMemoryDirectory（4.1/2.4）
- `apps/electron/src/main/lib/agent/runtime/session-runtime.ts` — 爆了不直接 closed 改调 soft-reset（4.3）
- `apps/electron/src/main/lib/ipc/session-service.ts` — GET_SDK_MESSAGES 改读面板份 + 双写 + 透传 + onTurnStart/recordSession 接线（1.2/4.1/2.5）
- `apps/electron/src/main/index.ts` — memory 服务启动 wiring（2.1）
- `apps/electron/src/renderer/components/chat/Chat.tsx` — token 栏 fallback 对齐（1.1）
- `apps/electron/src/main/lib/channel/default-models.ts` — 填窗口值（1.1）

**新建**：
- `apps/electron/src/main/lib/channel/model-window.ts` — resolveModelContextWindow（1.1）
- `packages/pi-core/src/session-memory-coordinator.ts` — pi 8k 四层协调器（3）
- `apps/electron/src/main/lib/agent/kscc-soft-reset.ts` — kscc 软重置状态机（4）
- `apps/electron/src/main/lib/memory/` — 7 个 General 服务移植 + agent-prompt-builder + agent-context-utils + agent-session-compactor + history-normalizer（2/5）
- `apps/electron/src/renderer/components/memory/` — 4 个 UI 组件移植（2.3）

**移植源**（`/f/TAgent_General/apps/electron/src/main/lib/`）：
memory-layer-service / nudge-service / memory-evidence-sink / memory-consolidation-service / idle-memory-consolidation-scheduler / reflect-service / scheduled-cleanup-service / self-repair-service / stage-queue-service / agent-prompt-builder / agent-context-utils / agent-session-compactor；UI：MemoryMonitorPanel / MemoryGraph / StageQueueCard / NudgeToast。

---

## 8. 验证总览（细节在各 Phase 文档）

- **pi 8k**：单测预算自适应（8k/32k/200k/1M）+ reconcile 切点分流；集成 mock streamFn 验 lmidChain/事件；手测灌 200k+ 验不阻塞 + cache 命中。
- **kscc 软重置**：单测状态机转移 + 补尾 + 归档 + 原子回滚 + 爆了兜底；集成真实 kscc+GLM-5.2 灌 256k 验用户无感切换 + B 转正。
- **L5 移植**：单测 schema/FTS5/nudge 4 模式/evidence 原子/consolidation 9 步；集成记忆页四组件；手测 Nudge accept 写入下会话 Frozen 命中 cache + 防线验证 LLM 不写 memory md。
- **爆了恢复**：构造 256k 爆点验 session-runtime 不 closed 走 preparePromptTooLongRecovery + 自学习回写；回归旧会话单 JSONL fallback 不崩。

---

## 9. 待办

- [x] 写 `phase-1-data-foundation.md`（Phase 1 细节）
- [x] 写 `phase-2-global-l5-port.md`（Phase 2 细节）
- [x] 写 `phase-3-pi-8k-coordinator.md`（Phase 3 细节）
- [x] 写 `phase-4-kscc-soft-reset.md`（Phase 4 细节）
- [x] 写 `phase-5-polish.md`（Phase 5 细节）

> 子文档在本 plan 批准后写全。本主文档先定方向，供审阅。
