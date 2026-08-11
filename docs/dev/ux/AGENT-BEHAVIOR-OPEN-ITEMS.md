# Agent 行为（圆桌 / 子代理 / CLI 工人 / Guard）· 未收口清单

> 日期：2026-08-11　·　**只读摸底**，未改任何代码。
> 范围：最近跟 agent 行为有关的「未做 / 待定 / 缺口 / 未收口」。重点圆桌(MoA)、子代理、CLI 工人、Agent 行为设置、No-Progress Guard。
> 方法：扫 `docs/dev/{moa-roundtable,cli-workers,cli-probe-2026-08-10,core-loop,kscc-acp,ux}` + `docs/plans/multi-runtime` + `docs/memory/handoff.md`；对照 `apps/electron` 与 `packages/{shared,core}` 代码粗核。
> 真源文档：`docs/plans/multi-runtime/10-session-agent-behavior-orchestration.md`（主设计，说/议/干）、`docs/dev/moa-roundtable/HANDOFF-2026-08-10.md`、`docs/dev/cli-workers/HANDOFF-2026-08-10.md`、`docs/dev/core-loop/NO-PROGRESS-GUARD-{FINDINGS,CLOSURE-AUDIT}.md`、`docs/dev/core-loop/SUBAGENT-FAIL-ROUND2-FINDINGS.md`。

---

## 0. 一句话现状

圆桌双模式（会诊 + 研讨）、CLI 工人 SLICE-1..10、Agent 行为设置分页、No-Progress Guard **均已合入 main**（`7b0f3b0..fc17ebf`）。两条 HANDOFF 与 closure-audit 里的「未做」表**大多已 stale**。真正仍欠的是：① 默认 `enforce` 的 Guard 从没跑过实机验证矩阵；② 圆桌 / opencode / claude / CLI 全链路**只过单测、从未真机手测**；③ 「运行出错」的**真实根因**（resume/重连 + 429 限流）与 Guard 正交、未收口；④ 一批已实现功能里的真实缺口（vision 传输、班组 IA、看板回流重置圆桌卡、@ 防递归）。

---

## 1. 已收口（不再欠，勿重做）

> 这些在旧 HANDOFF/audit 里被列为「未做」，但代码已合入并经单测 + 回归。列此防重复劳动。

| 项 | 证据 |
|---|---|
| CLI 工人能力画像 + require/prefer 路由 + 能力卡注入（旧 HANDOFF §7 P1「能力画像 未写代码」） | `7b0f3b0`；`resolve-backend.ts:46-112` 真过滤+打分；`subagent-task-tool.ts:206-209` 注入能力卡 |
| 设置页能力画像可编辑（cost/reasoning/vision/goodFor） | `86f6555`；`CliWorkersSettingsSection.tsx` 高级区 |
| 会话级 CLI 工人选择器 `meta.cliWorkerId`（旧 §7 P2） | `caee1ed`；`agent.ts:1123`、`pi-agent-adapter.ts:1174`、`RunModeSelector.tsx:225-264` |
| 启动自动探测 + 动态工人池（旧 HANDOFF 说「探测手动，进页不扫」**已推翻**） | `e7da675`；`cli-workers-service.ts:166-185`、`main/index.ts:302-308` |
| opencode runner 转正 | `4a41bbc`；`run-opencode-worker.ts` + `opencode-stream-observer.ts` |
| claude-code runner 转正 | `bf193fe`；`run-claude-worker.ts` + `claude-stream-observer.ts` |
| 六 CLI 目录（kscc/grok/codex/mimo/opencode/claude）全 `supported:true` | `cli-workers.ts:158-170`；`SUPPORTED_CLI_WORKER_IDS` 6 项 |
| 圆桌研讨：状态机/多轮编排/共享纪要/提前收敛/轮数可配/插话喊停/终态落盘+重启回放/跨轮续聊(T7) | `moa-discussion.ts`、`run-moa-discussion.ts`、`moa-history.ts`、`MoaDiscussionCard/Room.tsx`、IPC `DISCUSSION_INTERJECT/STOP/REPLAY_MOA_DISCUSSIONS` |
| 会诊班底 CRUD + 研讨轮数编辑器（`MoAPreset.roundLimit` 1-6 默认 3） | `AgentBehaviorSettings.tsx`（PresetEditor 706-733）；`agent:save-moa-presets` IPC |
| Agent 行为设置分页（会诊/子代理/班组/圆桌 四 tab，`normalizeSettingsTab` 归一） | `SettingsPage.tsx:113/139-166/87` |
| AskUser 点选回灌 `updatedInput.answers`（ROUND2「候选，待证」） | `agent-ask-user-service.ts:91-109`、`permission-service.ts:351-358`；单测覆盖 |
| haiku 钉死修复（kscc-internal 不再钉 haiku，继承父模型） | `831c941`；`session-service.ts:1743`、`default-models.ts:75-77` |
| No-Progress Guard 代码落地 + 默认 `enforce` + 双核 hooks + classify | `fc17ebf`；`no-progress-guard.ts`、`no-progress.ts:27`、`claude/pi-agent-adapter` |

---

## 2. P0 · 行为已上线但未经验证 / 有真实回归风险

| # | 项 | 现状 | 缺口 | 建议下一步 |
|---|---|---|---|---|
| P0-1 | **No-Progress Guard 默认 `enforce` 但 NP-0 实机矩阵从未跑** | `NO_PROGRESS_GUARD_DEFAULT_MODE='enforce'`（`no-progress.ts:27`），双核 hooks 已接（`claude-agent-adapter.ts:457-502`、`pi-agent-adapter.ts:1356-1384`），已 commit `fc17ebf` | SPEC §20.1 放行条件（NP-0 绿 + shadow 误报率达标）**未满足**就切了 enforce；`PostToolBatch additionalContext` 真到模型 / `PreToolUse deny` 与 `canUseTool` 并存顺序 / `interrupt()` 续跑能力均**纸面推断**（FINDINGS §5/§6、closure-audit §5.3） | 先跑 NP-0 双核 9 场景矩阵；绿则保留 enforce，否则回 `shadow` 默认先收误报数据。FINDINGS §22 Step 7 表 |
| P0-2 | **「运行出错」真实根因未收口（与 Guard 正交）** | closure-audit 实证最近用户「打包版报错」**不是**工具循环 / `error_max_turns`（两条会话均 0 命中），是 ① 旧会话 resume/重连失败（`28d4d411`：turns 完成但 `status:error` 无终态 result）+ ② 429 TPM 限流被显示为「运行出错」（`bddb5510`，SDK 静默重试恢复） | Guard 对这两类**不起作用**；resume/重连可靠性 + 限流用户可见文案**单独未做**（audit §5.4 明列正交） | 单独线：会话 resume/重连失败做专门恢复/分类；429 在 SDK 重试耗尽后归 `rate_limited`（「请求过于频繁」）而非「运行出错」 |
| P0-3 | **圆桌研讨 + opencode/claude runner + CLI 全链路从未真机手测** | 圆桌 HANDOFF §7 手测清单（发起→插话→收敛→重启恢复→续聊）「只过单测没跑 GUI」；opencode/claude 本机**未装**、fixture/单测 only（SLICE-9/10 明说）；task→CLI→observer→详情全链路无真机 | 已 commit 的多条功能路径**零真实运行**佐证 | ① 按 moa HANDOFF §7 跑圆桌全链路；② 本机装/登录 opencode+claude 冒烟 `run --format json` / `-p --bare --output-format stream-json`；③ 跑 task 派发+并行+停止杀进程全链路 |

---

## 3. P1 · 已实现功能里的真实缺口（影响正确性 / 可用性）

| # | 项 | 现状 | 缺口 | 建议下一步 |
|---|---|---|---|---|
| P1-1 | **多模态 / 视觉附件进 CLI 缺传输** | `vision` 是路由 flag（`subagent-task-tool.ts:55`），6 runner 只收 `prompt: string` | 无任何 image/path/base64 传到 CLI 子进程；`require:vision` 会路由但图**永远到不了** CLI；`input:['text']`（`:576/590`） | 定路径约定 + task schema 加附件参数 + runner 传文件路径（旧 HANDOFF §7 P2） |
| P1-2 | **看板完成回流 `setItems` 重置讨论入口卡** | `Chat.tsx:964/992` `onKanbanBoardCompleted` 仅按 panel 历史 IR + `rehydrateSubagentTaskCardsFromHistory` 重水化 | 不合并现有 `moaDiscussion`/`moaRoundtable` 入口卡 → 讨论入口卡被丢（moaRoundtable 同款） | 重水化时合并保留当前 moaDiscussion/moaRoundtable 入口卡 |
| P1-3 | **圆桌班组 阶段3 信息架构（最大剩余块）** | `KanbanCrewPanel` 骨架在；`SubagentDetailView` 已有可复用 | ① flow 依赖图（`dependsOnTaskIds` 现仅文本列 blocker id，无图）；② worker 全屏会话页（现内嵌 transcript）；③ 嵌套 subagent 入口（三级导航，现状无） | 先做 worker 全屏会话页（复用 SubagentDetailView），再做 flow 图（主设计 §7.3、§9 阶段3） |
| P1-4 | **Windows Bash 工具 fork 失败** | `kscc-windows-spawn.ts:39-65` 只覆盖 **kscc CLI** spawn（node.exe 直跑绕 .cmd） | GUI 主程序 **Bash 工具**本身 `Exit code 5 / add_item failed`（git bash cygwin fork）未下放补丁；逼模型弃 Bash 改 Glob/Read（ROUND2 §6c，记忆 [[windows-git-bash-sandbox-fork]]） | 把 node.exe 直跑 / PATH 补全思路下放到 Bash 工具层（或 dev 启动补 PATH） |

---

## 4. P2 · 显式挂起 / 低优先 / 收尾打磨

| # | 项 | 现状 | 缺口 | 建议下一步 |
|---|---|---|---|---|
| P2-1 | **@ 防递归深度上限（`maxAgentMentionDepth`）** | 代码**零**实现（grep 全空）；唯一递归护栏是 `kanban-worker-runner.ts:40-45` `isBlockedWorkerTool`（拦建板，与 @ 无关） | @ 点名无深度上限（主设计 §9 阶段4 / `04` spec 提及） | 搬 Hermes 思想原创实现 @ 深度上限 |
| P2-2 | **议→干建议条（结论卡 CTA 接 Chat/Work 确认条）** | Chat/Work 确认条已有；结论卡未接 CTA | 圆桌/会诊 done →「照着干」CTA 未连（主设计 §8/§9 阶段4） | 结论卡加「照着干」CTA → 切 Work 确认条 + 建板 |
| P2-3 | **T7 夹中场景跨轮续聊丢 MoA 上下文（长驻进程）** | T7 已修「无进程/重启」与「进程活」两态 | 长驻进程夹中场景仍可能丢（主设计 §9 阶段2 剩余缺口） | 「共识回写主会话进程」改造 |
| P2-4 | **CLI 工人自定义 runner 插件机制** | 所有 runner 硬编码于 `run-cli-worker.ts:37-69` switch；自定义 id 仅展示「暂不支持」 | 用户自定义 id 可插桩第三方 CLI（免改主分支）—— SLICE-9/10 明列「持续挂起」 | 未来再做 |
| P2-5 | **kscc-core 会话级工人选择器** | `createTaskTool` 仅 Pi 核注册（`pi-agent-adapter.ts`）；kscc-core 无 `task` 工具/`cliWorkerId` 路径 | kscc 核会话无法选工人（SLICE-7 明确排除） | 若需要再为 kscc-core 接 task 工具 |
| P2-6 | **NoProgress 收尾打磨** | enforce 默认 + 双核 hooks + classify 已在 | ① Pi `warn` 无模型注入（`afterToolCall` 不能注 `additionalContext`，需 pi-agent-core hook）；② UI 组件（warning/reflection/cleared 阶段，现状仅 paused 清 running）；③ `error_max_turns` banner 仅改文案未改色；④ §18 未决（per-session opt-out 仅 env 无设置开关、阈值未按工具类型加权、subagent 内循环按 Task 中性） | NP-0 绿后逐项收尾（FINDINGS §5/§21） |
| P2-7 | **班组 / 圆桌 settings 占位页** | `agent-crew`/`agent-discuss` 渲染 `<AgentComingSoonPage>`「即将推出」（`SettingsPage.tsx:380/407-420`） | 圆桌**故意**经会诊编辑器 `roundLimit` 配（非独立表单）；班组待阶段3 | 班组随 P1-3 填表单；圆桌维持现状 |
| P2-8 | **haiku 修运行验证** | 代码已修 + commit（`831c941`） | 无修复后真实派发 trace（ROUND2 §6b 待证，其「跑旧构建」caveat 现已 stale） | rebuild+重启后开 Work+glm 派 explorer，确认子代理 `model:glm-5.2` + `completed` |

---

## 5. 文档漂移 / 过时（建议顺手清或标注 stale）

| 文档 | 漂移点 |
|---|---|
| `cli-workers/HANDOFF-2026-08-10.md` §7 表 | 「能力画像 未写代码」「会话级工人选择器 P2」「能力卡注入 P2」**均已 DONE**（SLICE-5/6/7）；手测 CLI 数从 4 变 6 |
| `core-loop/NO-PROGRESS-GUARD-CLOSURE-AUDIT.md` §0/§1 | 「未收口 / 未 commit / 未进包 / 默认 shadow」为 **commit `fc17ebf` 前**快照；现实现已 commit、默认 `enforce`。仍有效的是 §5.3（NP-0 未跑）与 §5.4（运行出错正交） |
| `moa-roundtable/HANDOFF-2026-08-10.md` §3 vs §5 | §3 标「全部完成」但 §5 列的「阶段3/4 + 小缺口」仍未做（见 P1-2/P1-3/P2-1/P2-2/P2-3） |
| `run-moa-discussion.ts:10` | 注释「本编排暂不处理插话注入，留后续任务」——**插话已实现**（`:90/503-509/620-625`） |
| `MoaDiscussionRoom.tsx:18/38/40/267/285/295` | 「接线后续任务 / 接线中」——回调**已接**（`Chat.tsx:2934/2944`）；按钮 title 仅在回调缺失时显「接线中」 |
| 命名 | 用户可见名「会诊 / 圆桌」已定；内部符号 `moa_roundtable`/`moa_discussion`/`moa-agg-*`/`moa-disc-agg-*` **勿改**（两 HANDOFF 均嘱） |

---

## 6. 优先级一句话总结

- **P0**：Guard 默认 enforce 未跑实机矩阵（回归风险）/ 「运行出错」真实根因未收口 / 圆桌+CLI 全链路从未真机。
- **P1**：vision 附件传输缺 / 看板回流重置圆桌卡 / 班组阶段3 IA / Windows Bash fork。
- **P2**：@ 防递归 / 议→干 CTA / T7 夹中 / 自定义 runner 插件 / kscc-core 工人选择器 / NoProgress 收尾 / 占位页 / haiku 运行验证。

> 建议起手顺序：P0-1（NP-0 矩阵，决定 enforce 去留）→ P0-3（圆桌手测，顺带清 §5 过时注释）→ P0-2（运行出错另线）→ P1-1/P1-2（小而实的缺口）→ P1-3（班组大块）。
