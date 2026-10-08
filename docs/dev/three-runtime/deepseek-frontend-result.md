# ADR-0011 首期切片：渲染层实现结果（DeepSeek 侧，接替 Grok）

> 日期：2026-09-16（含 frontend review 修正轮）
> 范围：**仅** `apps/electron/src/renderer/**` + 本报告。未改 main / preload / packages/shared（按分工由另一路持有）。
> 基线：`fa1ce5b feat: complete fusion session core flow` + 全部既有脏改动（未 reset / 未 checkout / 未提交 / 未安装依赖）。
> 状态：**代码完成；聚焦渲染层测试 543 用例通过；渲染层 `tsc --noEmit` 无报错**（见 §6 for 唯一一条非本路报错）。

## 1. 交付的能力

输入区新增**独立**的「主 Agent」选择器（Pi / Codex / Claude Code / KSCC），与模型选择器分离：

- 触发器：内核图标 + 名称（窄栏只留图标），h-7 槽位与「运行模式」/ 模型钮对齐，沿用既有 pill 材质与 `@tagent/ui` 的 Popover / MenuPopoverItem，不引入新视觉体系。
- 弹层：三行内核 + 可用性描述 + 当前项勾选；Codex 不可用且平台受支持时内嵌「安装 Codex Runtime」动作（从 RunModeSelector 迁入，行为不变）。
- 模型选择器按当前内核**精确过滤**（`channelAcceptsRuntime` 与主进程同构）：Pi 只列外部 API 渠道，Codex 只列 codex-internal，Claude Code 只列 kscc-internal。任意 HTTP 渠道模型不可能被伪造成跑在 Codex/KSCC 上；Codex 与 KSCC 在旧 `coreKind` 下同为 `'kscc'`，因此过滤按 **runtime** 而非 core 判定。
- 草稿会话：切换只改本地一致选择（渠道 + 模型一起换），首条消息发送时物化，不调持久化 API。
- 已物化会话：走事务性 `switchSessionRuntime`，成功采纳主进程回传的 `channelId / modelId / internalBackend`。

## 2. 切换语义（对齐主进程契约）

| 场景 | 行为 |
| --- | --- |
| 会话运行中（running / startedAt 残留） | 入口禁用并提示「请先停止当前回合，再切换主 Agent」；兜底 toast 不发请求（`blockedByBusy`） |
| 目标内核无可用渠道 | 明确报错「X 没有可用的渠道/模型」+ 去「设置 → 渠道」配置的指引；**不静默改用其它内核** |
| 切换在途 | **同步**闸门（ref，非 useState）保证只有一个切换 promise；Agent 入口转圈禁用、模型选择器禁用、`send()` 与 `sendQueued()`（含会诊 / 讨论 / 看板派工 / 队列重投）统一拒绝、`SendSplitButton.hasDraft=false` |
| 连续点击 | 第二个调用在闸门处直接返回（`blockedByPending`），**不发第二个 IPC** |
| 切走会话 | 闸门 `invalidate()` + `sessionIdRef` 双重校验：迟到的成功 / 失败 / 提示一律丢弃，不改本地状态 |
| 切换失败 | 无乐观写入；`onRollback` 恢复捕获的旧 `selectionOverride` / `internalBackend` / touched 标记，并 toast 展示主进程错误 |
| 切换成功 | 采纳 meta → `selectionOverride` + `internalBackend` + `metaRef` + tab 绑定（`tabsAtom`）+ 侧栏刷新；**仅草稿**才写全局默认原子 |
| 重载后 | 会话按持久化 `channelId / modelId / internalBackend` 还原；迟到的 `listSessions()` 快照不再覆盖本次切换结果（`internalBackendTouchedRef` 守卫） |
| 渠道被删除的旧会话 | 内核解析为 `null`（显示「选择 Agent」，模型菜单提示先选 Agent），不会自动挑一个别的内核顶上 |

用户可见文案刻意保守：「已切换到 X」+「从下一条消息起交给新内核，会带上**最近可见对话的节选（不是完整迁移）**」——主进程交接资料本就有字符预算，UI 不宣称全量迁移。

## 3. 新会话默认：Pi 优先，且**不做本机内核自动回落**（评审修正）

`resolveModelSelection` 语义收敛为：

1. `preferred` 仍可用 → 原样保留（**显式选择 / 已保存会话绑定优先于任何默认值**）；
2. 否则取第一个可用的**外部 API 渠道**默认模型（新会话默认跑 Pi）；
3. 没有任何可用外部渠道 → **`null`**：UI 明确提示「配置 Pi，或用 Agent 选择器显式选择 Codex / Claude Code（KSCC）」，**不再自动回落到 kscc / codex**。

配套修正：

- `selectedChannelIdAtom`（旧写渠道入口）不再走 Pi 策略，改为「写入哪个渠道就用哪个渠道的默认模型」——否则显式写入本机渠道会被清空。
- `loadChannelsAtom` 仍保留「已存在的可用选择」（含本机内核），只在选择失效时才重新解析。
- Chat 的 `effectiveSelection` 优先级：本会话最近选择 → 持久化绑定 → **无渠道绑定会话的原生线索兜底**（`runtimeBoundBySessionMeta`：`internalBackend` → 对应内核 → 该内核渠道）→ 全局默认。让「新会话默认 Pi」无法悄悄换掉一个没有 channelId 的历史会话。
- 全局 `selectedModelSelectionAtom` 现在只表示「新会话默认」：**只有草稿上的显式选择**才写回；在某会话里切核 / 换模型不再污染下一个新会话的默认内核。
- 无选择时的提示文案改为「没有可用的模型：请先在「设置 → 渠道」配置 Pi 的外部 API 渠道，或用输入区左侧的 Agent 选择器显式选择 Codex / Claude Code（KSCC）」。

## 4. 模型菜单 / legacy 选择不得绕过内核事务（评审修正）

- `handleModelSelection` 先按 `runtimeForChannelProvider` 算出目标内核：与当前内核一致 → 只改本地 `selectionOverride`；**跨内核**（legacy 数据 / 旧 override）→ 改走 `switchRuntimeTo(runtime, explicitSelection)` 的事务路径，不再调用 `updateSessionMeta` 旁路（`changeInternalBackend` 已整体删除）。
- 切换目标会再校验：渠道必须是该内核的承载渠道、渠道已启用、模型是真实启用模型（`isMoaModelId` 显式挡掉 MoA 虚拟模型；`selectionForRuntime` 只返回 enabled 渠道的 enabled 默认模型，MoA 默认值 → fail-closed 返回 null）。
- 发送路径不再信任可能过期的 props/state：`sendQueued` 由**本轮 selection** 推导 `runtime` 与 `internalBackend`（Pi 不带 backend；Codex/KSCC 带各自后端值），并用 `runtimeForChannelProvider(provider, internalBackend)` 兼容「kscc-internal 渠道 + codex-app-server」的旧会话。

## 5. 改动文件（本轮修正涉及）

新增：

| 文件 | 说明 |
| --- | --- |
| `renderer/atoms/agent-runtime.ts` | 纯判定：provider↔内核映射、`channelAcceptsRuntime`（同构主进程）、可用渠道过滤、`internalBackendForRuntime`、`runtimeBoundBySessionMeta`、`selectionForRuntime`（挡 MoA） |
| `renderer/atoms/agent-runtime.test.ts` | 12 用例（含「无 Pi 不回落」/「MoA 不当切换目标」/「旧会话原生线索兜底」） |
| `renderer/atoms/channel-atoms.test.ts` | 3 用例（显式写入本机渠道不被清空；`loadChannelsAtom` 的 Pi-or-null 默认） |
| `renderer/components/chat/AgentRuntimeSelector.tsx` | 新选择器（含 Codex 安装动作迁移） |
| `renderer/components/chat/AgentRuntimeSelector.test.tsx` | 7 用例 |
| `renderer/components/chat/runtime-switch-flow.ts` | 切换流程骨架 + **同步闸门**（`createRuntimeSwitchGuard`）+ 过期完成判定 |
| `renderer/components/chat/runtime-switch-flow.test.ts` | 10 用例（busy / draft / pending / adopt / rollback / 同步并发 / 会话过期 / pending 复位） |

修改：

| 文件 | 改动 |
| --- | --- |
| `renderer/atoms/model-selection.ts` | 默认策略改为 **Pi-only**（无外部渠道 → null），显式选择优先 |
| `renderer/atoms/model-selection.test.ts` | 用例改为 Pi 优先 / 不回落 / 保留显式选择 |
| `renderer/atoms/channel-atoms.ts` | `selectedChannelIdAtom` 写入语义修正（不套用 Pi 策略） |
| `renderer/components/chat/Chat.tsx` | `effectiveRuntime` / `lockedKind` 按生效内核推导；`switchRuntimeTo`（锁 + 身份校验 + 回滚）；`handleModelSelection` 跨内核改走事务；`effectiveSelection` 增加原生线索兜底；全局原子只在草稿写；发送按 selection 推导 backend；切会话 invalidate 闸门；Codex 状态无条件探测；提示文案 |
| `renderer/components/chat/ModelSelector.tsx` | 按 runtime 精确过滤；`runtime === null` 时不列任何模型并提示先选 Agent；在途禁用 |
| `renderer/components/chat/RunModeSelector.tsx`（+ test） | 移除重复的「主 Agent」段与相关 props，避免双入口 |
| `renderer/App.tsx` | `window.electronAPI.switchSessionRuntime` 类型声明（渲染层全局 ElectronAPI 是手写清单） |

**未改**：main / preload / packages/shared、用户配置与凭据；未新增依赖；未提交；既有脏改动全部保留。

## 6. 验证

```
node node_modules/vitest/vitest.mjs run apps/electron/src/renderer
  → Test Files 53 passed / Tests 543 passed

node apps/electron/node_modules/typescript/bin/tsc --noEmit -p apps/electron/tsconfig.json
  → 仅 1 条非本路报错：apps/electron/src/main/lib/agent/runtime/session-runtime.test.ts
    （main 侧文件，mtime 显示由并发的后端 worker 正在编辑；渲染层改动无报错）
```

覆盖到的关键断言：

- 内核↔渠道映射；`pi` 不接本机渠道；codex/kscc 不接任意 HTTP 渠道；
- 新会话 Pi 优先；**无外部渠道 → null（不回落 kscc/codex）**；显式/已保存选择优先；
- 停用渠道、停用模型、MoA 虚拟模型都不会成为切换目标；
- 忙时拒绝且**不发 IPC**；草稿不调持久化 API；成功采纳主进程 meta 并清 pending；
- **同一 tick 连续点击只有一个切换请求**（同步闸门）；闸门完成后可再次切换；
- **切走会话后的迟到成功/失败既不采纳也不回滚**，且不会卡住 pending；
- 失败回滚 + pending 复位 + 错误交给调用方展示。

## 7. 限制与遗留

1. **未做实机验收**：没有真实 Codex Runtime / 外部 API 渠道下的端到端手工验证（交接投递由主进程侧单测覆盖，UI 侧未跑）。
2. **忙时不做自动停止**：本切片按 brief 采用「明确要求用户先停止」，未做「自动 stop → 等真正 idle → 再切换」的重试链。
3. **无渠道绑定的历史会话**只在 `internalBackend` 有值时才还原原内核；两者都没有的会话仍退回全局默认（无任何原生线索可用）。
4. 「新会话默认」由内存中的 `selectedModelSelectionAtom` 承载：用户在草稿上显式选过的内核会沿用为下个草稿的默认（等价于「保留显式选择」），不是每次都强制回 Pi。
5. `RunModeSelector` 的「主 Agent」段被移除（迁入新选择器）：若外部有按文案定位该弹层的自动化脚本需同步。
6. 触发器在极窄宽度下与模型钮竞争空间，只做了 `compact` 图标模式与 truncate，未做更细的响应式收缩。
7. 未列出的旧行为（比如 legacy 粘性 `moa:*` 会自动落回同渠道真实模型）保持原样，仅补了「不写全局默认原子」的隔离。
