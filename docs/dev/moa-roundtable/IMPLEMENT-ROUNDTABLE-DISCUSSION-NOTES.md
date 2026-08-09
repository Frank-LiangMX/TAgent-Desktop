# 圆桌 · 研讨（multi-turn deliberation）实现笔记

> 设计依据：`docs/plans/multi-runtime/10-session-agent-behavior-orchestration.md` §5
> 状态：阶段 2 已实现（2026-08-10）· 待手测
> 关联：`docs/dev/moa-roundtable/` 既有 MoA 主线（会诊）

---

## 1. 任务清单（T1–T11）

| 任务 | 内容 | 关键文件 | 验证 |
| --- | --- | --- | --- |
| T1 | 共享类型 + 纯函数状态机（discussing→finalizing→done/error/cancelled；user/moderator 席自动生成） | `packages/shared/src/types/moa-discussion.ts` (+test) | 14 用例 |
| T2 | 主进程多轮编排：串行多轮、轮数上限、总结人收口、取消 | `apps/electron/src/main/lib/agent/run-moa-discussion.ts` (+test) | 7 用例 |
| T3a | 渲染层 UI：▾ 菜单项、入口卡、全屏讨论室、事件 upsert/挂载 | `MoaDiscussionCard.tsx` / `MoaDiscussionRoom.tsx` / `Chat.tsx` | typecheck |
| T3b | 发送链路：`SendMessageInput.moaDiscussionPresetId` → session-service 分流 → runMoADiscussion | `session-service.ts` / `preload/index.ts` / `Chat.tsx` | 全量回归 |
| T4 | 用户插话/喊停：`DISCUSSION_INTERJECT` / `DISCUSSION_STOP` IPC + 编排层 drain | `session-service.ts` / `preload/index.ts` / `run-moa-discussion.ts` | 1002 全过 |
| T5 | 会话历史注入：`buildHistoryForTurn`（仿会诊，排除本轮 user） | `run-moa-discussion.ts` | 10 用例 |
| T6 | 命名统一「圆桌 · 快速 / 圆桌 · 研讨」+ 讨论室主会话化（头像/markdown/滚动/输入框 UI） | 渲染层多处 + `chat.css` | 992 全过 |
| T8 | 终态落盘 + 重启恢复：`<sessionId>.moa-discussion.jsonl` + `replayMoADiscussions` | `session-store.ts` / `config-paths.ts` / `session-service.ts` / `Chat.tsx` | 1006 全过 |
| T9 | 提前收敛规则：≥2 轮后发言过短（≤80 字）或信号词命中 ≥60% → 收口 | `moa-discussion.ts`（`evaluateDiscussionConvergence`） | 1018 全过 |
| T10 | 轮数可配：`MoAPreset.roundLimit`（1–6，缺省 3）+ 设置编辑器「研讨轮数」 | `moa-preset.ts` / `AgentBehaviorSettings.tsx` | 1024 全过 |
| T11 | 共享纪要层：每 2 轮隔离纪要模型滚「当前目标/已确认决定/未决事项 + 收敛标记」；参与者读纪要而非全文；纪要收敛优先、T9 降级；讨论室可折叠纪要区 | `moa-discussion.ts`（`updateDiscussionRunningSummary`）/ `run-moa-discussion.ts` / `MoaDiscussionRoom.tsx` | 1041 全过 |

## 2. 关键设计决策

- **记录员纪要（借鉴 Hermes 思想，代码/提示词原创）**：每 2 轮用 `preset.aggregatorModelId` + 现有 seatRunner 跑一次纪要（无工具、30s 超时、失败降级不阻断）；旧纪要当基线、新发言当增量滚动更新；下一轮参与者 prompt = 议题 + 纪要 + 自上次纪要以来的发言，不再全文堆积。
- **收敛双保险**：纪要「收敛: 是」（未决事项为空）优先；T9 规则（短发言/信号词）作纪要失效时的降级；两者都命中才收口（任一命中即收）。
- **无状态单发架构**：每席每轮 = `spawnKsccBare` / Pi HTTP 直连一次性调用，"多轮对话"由编排层重发 prompt 模拟——这是轻量方案的取舍，模型无真会话状态（后续可演进为真会话/共识回写主会话）。
- **落盘仅终态**：中间 entries 不逐条落盘，终态 panel 一行一 JSON；重启经 `replayMoADiscussions` 恢复入口卡（插到共识消息前）。
- **one-shot 语义**：圆桌 · 研讨不写 sticky `moa:*`，选择器保持真实模型；轮数走班底 `roundLimit`。

## 3. 已知缺口 / 后续

- **T7 夹中场景**：普通轮 → 圆桌 → 续聊，在长驻进程（LIVE）或重启有 `sdkSessionId`（RESTART）时，续聊可能读不到 MoA 轮——需「MoA 共识写回主会话进程」改造（Pi 核可直接 push `agent.state.messages`；kscc 需评估 SessionRuntime 追加机制）。
- **阶段 3**：班组 flow 依赖图、worker 全屏会话页、嵌套 subagent 入口。
- **阶段 4**：@ 防递归深度上限（借鉴 Hermes `maxAgentMentionDepth` 思想）、议→干建议条。
- 讨论进行中主会话输入框不路由到圆桌（插话需进讨论室输入框）；看板完成回流 `setItems` 会重置讨论入口卡（与 `moaRoundtable` 同款既有行为）。

## 4. 验证

- 全量 `bun run test`：1041 用例全过（截至 T11）。
- `apps/electron` typecheck：仅既有 `Chat.tsx:708` `modelId` 错误（任务前存在，未修）。
- 未 commit（遵项目规矩）；工作树改动待用户验收后统一提交。
