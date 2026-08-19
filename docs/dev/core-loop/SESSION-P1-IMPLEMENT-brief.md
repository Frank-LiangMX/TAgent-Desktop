# Brief · P1 会话 UX 残留 + Work 调度策略

> 交卷者：`kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> 规格：[SESSION-UX-RESIDUAL-SPEC.md](./SESSION-UX-RESIDUAL-SPEC.md) + [SESSION-DISPATCH-POLICY-SPEC.md](./SESSION-DISPATCH-POLICY-SPEC.md)  
> **禁止**改 Plan Mode 已合代码、collab room 业务、Pi/KSCC 核。可改 prompt / shared utils / Chat / AskUser / subagent-ui-model。

## 目标（P1 全做；§5 子代理耗时 P2 若时间够也做）

### A. AskUser 关窗 ≠ 停止（UX §1）

- `AskUserQuestionBanner` 关闭按钮 tooltip 现为「关闭并终止 Agent」——**改**为「关闭，未选择（Agent 自行默认继续）」；**不得**调 `stopAgent` / `userStopRun`（`handleDismiss` 已只调 `askUserDismiss`，核对无其它路径）。
- 若 result/error 分支把 AskUser dismiss 后的 SDK `[Request interrupted by user]` 当 abort → **不要** `recordCompletion('stopped')` + hard stop。可：短窗口内（如 3s）且上一动作是 ask dismiss → 忽略 abortLike。
- 单测或窄测：dismiss 不触发 stopRun。

### B. AskUser 文案规则（UX §2 + DP §3.5）

- 编辑 `apps/electron/src/main/lib/agent/execution-mode-prompt.ts` **Work 段**，新增小节「接着干 / Plan / AskUser」：
  - 用户说「接着开发/可以了/开干」→ **直接实现**，禁止 EnterPlanMode。
  - EnterPlanMode 仅：用户显式要大规划或 ≥3 模块 / 合 main 级。
  - Plan 内 Explore 子代理 ≤1 次/用户回合。
  - AskUser：选项 label 必须白话；禁止 §/ADR 编号做主标题；最多问一次「第一刀」，关窗后默认按 HANDOFF 推荐开干、勿重复问。
- 更新 `execution-mode-prompt.test.ts` 断言含上述关键词。

### C. 续聊摘要不进主线（UX §3）

- `packages/shared/src/utils/persisted-user-message.ts` `isControlUserText` 增加：
  - `/^This session is being continued from a previous conversation/i`
  - 可选：`/^\[会话已从上一段上下文续接\]/i`（若已有中文变体）
- 确保 `session-turn-model.isRealUserInput` / `isPersistedRealUserMessage` 排除（应已通过 isControlUserTextBlock）。
- 单测：`persisted-user-message` 或 `session-turn-model.test.ts` 加 1–2 case。

### D. turnDurations 整轮一条（UX §4）

- 审计 `Chat.tsx` 所有 `recordCompletion` 调用：仅 **result complete**、**用户 STOP**、**真 session_error** 写入。
- **禁止**：abortLike 误判（AskUser dismiss 后迟到 interrupt）、软停、turn_end 中间态写入。
- 若 `completeRun` 与 result 分支重复 record → 幂等（同轮只写一次）：可用 ref `completionRecordedRef`，startRun 清零。
- 单测可选：纯函数或 Chat 内 extract 测「同轮第二次 recordCompletion no-op」。

### E. 子代理耗时不用 stub（UX §5，P2 时间够则做）

- `subagent-ui-model.ts` `rehydrateSubagentTaskCardsFromHistory`：`endedAt` 用 **末条 parented assistant/user** 的 createdAt，不用 launcher 的 tool_result 时间。
- running 卡：`task_started` 到 `task_notification` 之间保持 running；勿因 stub tool_result 变 completed。
- 单测：`subagent-ui-model.test.ts` 加 stub 23ms + parented 60s 后 → endedAt 差 ≈60s。

## 验收

- [ ] vitest：改到的 test 文件全绿；至少跑 `execution-mode-prompt.test.ts`、`persisted-user-message`/`session-turn-model`、`subagent-ui-model`（若改）、permission 无关。
- [ ] AskUser X 按钮 tooltip 不含「终止 Agent」
- [ ] grep `recordCompletion('stopped')` 路径不绑 ask dismiss
- [ ] `isControlUserText('This session is being continued...')` === true

## 不做

- commit/push
- 改 collaboration-room-service 语法错
- Cursor Task

## 返回 stdout

改动文件列表 + 测试结果 + 未做项。
