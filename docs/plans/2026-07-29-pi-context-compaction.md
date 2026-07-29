# Pi 上下文管理与压缩（TAgent 自研）

> 状态：主线进行中（2026-07-29）  
> 范围：Pi 核长会话可用；kscc 另案。

## 1. 背景

TAgent 2.0 双核中，**Pi 核**上下文在主进程 `Agent.state.messages` 内累积，每轮整段带给模型。  
此前**无压缩**：窗口打满后只能报「上下文过长」。

kscc 核依赖 SDK 长驻 + resume，压缩走 SDK 事件（另案）。

## 2. 原则（红线）

| 可以 | 不可以 |
|------|--------|
| 使用 `@earendil-works/pi-agent-core` / `pi-ai` **官方 API**（`shouldCompact`、`prepareCompaction`、`compact`、`estimateContextTokens`、`DEFAULT_COMPACTION_SETTINGS`、`transformContext` 等） | 复制或粘贴 **Proma** 仓库中的业务代码、工具定义、续跑模板、adapter 封装 |
| 借鉴业界/Proma 的**产品意图**（约 80% 触发、手动压、UI 可见） | 依赖 `F:/Proma` 路径或把 Proma 文件当实现来源 |
| **TAgent 自研**阈值、触发时机、IPC、UI、与 session-runtime 的重试策略 | 把 Proma 的 `CompactContext` / continuation prompt 原样搬进本仓 |

**一句话：算法用 Pi，编排用 TAgent。**

## 3. Pi 原生能力（当前依赖 `pi-agent-core@0.82.x`）

包入口已 export compaction 与 harness 能力，例如：

- `shouldCompact(contextTokens, contextWindow, settings)`
- `estimateContextTokens(messages)` / `estimateTokens`
- `DEFAULT_COMPACTION_SETTINGS` / `CompactionSettings`（`enabled`、`reserveTokens`、`keepRecentTokens`）
- `prepareCompaction` / `compact` / `generateSummary`
- 底层 `Agent` 支持 `transformContext`（发模型前改写消息列表）
- 高层 `AgentHarness.compact()`（本阶段**不强制**上 Harness，优先在现有裸 `Agent` 路径接线）

原生阈值语义（文档/类型）：当 `contextTokens > contextWindow - reserveTokens` 时视为应压缩。

## 4. 目标架构（TAgent）

```text
PiAgentAdapter (自研)
  └─ new Agent({
       transformContext: tagentPiTransformContext,  // 自研钩子
       ...
     })

tagentPiTransformContext / maybeCompactMessages (自研)
  ├─ estimateContextTokens (Pi)
  ├─ shouldCompact (Pi) + 我方 settings（窗口、reserve、keepRecent）
  ├─ 将 messages 适配为 prepareCompaction 所需结构（或等价最小路径）
  ├─ compact / generateSummary (Pi)
  └─ 返回压缩后的 AgentMessage[]，写回或仅本轮喂模型

UI / IPC（后续 phase）
  └─ compacting / compact_boundary 事件 + 手动压缩
```

### 4.1 Settings（自研常量，不引用 Proma 模块）

建议默认（可后续进 settings.json）：

| 配置 | 建议默认 | 含义 |
|------|----------|------|
| `enabled` | `true` | 是否自动压缩 |
| `thresholdRatio` | `0.8` | 约 80% 窗口触发（换算为 reserveTokens） |
| `keepRecentTokens` | 使用 Pi `DEFAULT_COMPACTION_SETTINGS.keepRecentTokens` 或等价合理默认 | 压后保留近期量 |
| `contextWindow` | 模型声明值 → 推断 fallback（200_000） | 分母 |

`reserveTokens = ceil(contextWindow * (1 - thresholdRatio))` —— **公式自研写在 TAgent 仓库**，不 import 外部项目。

### 4.2 触发时机（Phase 1）

1. **自动**：`transformContext` 内，每次即将请求 LLM 前检查；需压缩则调用 Pi `compact` 路径，返回压缩后 messages。  
2. **过长错误后重试（可选同 Phase）**：命中 `prompt_too_long` 时强制 compact 一次再 `prompt`，仍失败则沿用现有中文错误。  
3. **手动 / 工具**（Phase 2）：IPC + UI，不在 Phase 1 必做。

### 4.3 与消息状态一致性

压缩后必须更新 **`agent.state.messages`**（或 Pi API 保证的持久结果），避免只改「本轮发送视图」导致下一轮又膨胀。

若 `prepareCompaction` 需要 session tree entries：优先用 memory session / 从当前 messages 构造最小 entry 列表；**不要**为了对齐 Proma 引入整套 SessionManager 业务逻辑。

### 4.4 可观测性

- 开始压缩：推 `system/compacting` 或现有 IR 能表达的事件（用 `@tagent/shared` 已有文案工具即可）  
- 完成：推 compact 完成类 system 消息（摘要可选截断展示）  
- 日志：`[pi-compaction]` 前缀

## 5. 分阶段交付

### Phase 1（本轮必做）— 长会话可用

- [x] 自研 settings + 窗口推断最小实现（`pi-context-settings.ts`）  
- [x] 接线 Pi `shouldCompact` / `generateSummary` + 自研切点/装配（`pi-context-compaction.ts`；未用 session tree 的 `prepareCompaction` 全路径，见实现注释）  
- [x] 挂到 Pi `Agent` 的 `transformContext`，并写回 `state.messages`  
- [x] 单测：阈值换算、shouldCompact 边界、noop/成功压缩  
- [x] typecheck 绿  


### Phase 2 — 产品完整

- [x] 手动压缩 IPC（`COMPACT_SESSION` + 输入区「压缩」按钮，仅 external）  
- [x] UI 分隔条 / 状态（compacting + compact_complete 事件）  
- [x] 过长自动 compact 再试（Pi `prompt` 抛错命中 prompt_too_long → force compact ×1）  

### Phase 3 — 可选增强

- [ ] 自研「请求压缩」工具（自定义名称与协议）  
- [ ] kscc SDK compact 对齐  

## 6. 明确非目标（本轮）

- 不升级到 Proma 同款 `pi-coding-agent` 全会话壳（除非单独 ADR）  
- 不实现 kscc 压缩  
- 不复制 Proma 源码  

## 7. 验收

- 外部渠道 Pi 会话在接近窗口时能自动压一轮，后续轮次 token 明显下降或不再立刻 prompt_too_long  
- 代码中无 `F:/Proma`、无从 Proma 粘贴的大段实现  
- 依赖仅限本仓 + `@earendil-works/*` + 现有 workspace 包  
