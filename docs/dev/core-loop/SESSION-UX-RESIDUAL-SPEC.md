# 会话 UX 残留规格（AskUser / 续聊 / 耗时）

> 日期：2026-08-18  
> 证据：`session-1786959659981` 关窗→中断、续聊摘要进主线、9 段 turnDurations。

## 1. AskUserQuestion 关窗 ≠ 用户停止

### 现象

@40 用户关选项弹窗 → tool_result `is_error`「用户关闭了选项弹窗…」→ @41 `[Request interrupted by user]` → meta `endedBy: stopped`。

### 目标

- 关窗 / dismiss：**仅** 回灌约定文案给模型（现有 error 文案可保留），**不** 触发 `userStopRun` / 不把整轮标 stopped。  
- 与 **用户点 STOP**、**权限 deny 硬停** 区分。  
- 模型应自行默认方案继续，且 **不应** 立即重复同一 AskUser（SDK 文案已要求）。

### 实现提示

- 查 `AskUserQuestionBanner` dismiss 路径是否误调 stop 或 emit interrupt。  
- 查主进程 `askUserService` dismiss/cancel 是否带 interrupt。  
- `session-turn-model`：`[Request interrupted by user]` 已是 control user，**不应**渲染气泡；但 meta stopped 来源可能在 Chat `recordCompletion('stopped')` 链。

### 验收

- [ ] 关 AskUser 弹窗后：running 可继续（或等模型下一句），侧栏 **非** stopped，无用户停止气泡。

---

## 2. AskUser 选项文案（产品规则）

### 现象

用户回「完全看不懂」——选项含 §13、adapter、fail-closed、S5/S6 缩写。

### 目标

Work prompt 或 AskUser 专用段补充：

- 每个 option **一行白话** + 可选副标题；禁止 ADR/规格编号做主 label。  
- 多选题干时 **默认推荐** 一项（header 或第一项 description 标明 Recommended）。  
- 与用户说「接着开发 / 开干」时：**优先给可执行默认**，不要反复问「第一刀」（最多问一次）。

### 验收

- [ ] 抽检：collab 类任务 AskUser header/label 无 `§`、无 `adapter` 裸词。

---

## 3. 上下文续聊摘要不进主时间线

### 现象

@446 `This session is being continued from a previous conversation that ran out of context...` 作为 **user 消息** 出现在主线（`mainUserPrompts` 第 5 条）。

### 目标

- 识别 kscc **session continue** 控制文（与 `[Request interrupted by user]` 同类）。  
- **不** 渲染为用户气泡；可选：  
  - 折叠系统条（类似 compact boundary），或  
  - 仅过程区一行「上下文已续接（摘要 N 字）」，或  
  - 完全静默仅内部上下文。  
- 不计入「用户回合」边界（turn 切分 / turnCount）。

### 实现提示

- 扩展 `isControlUserTextBlock` / `persisted-user-message` 哨兵：`/continued from a previous conversation/i`。  
- `session-turn-model.isRealUserInput` 排除。  
- 加载历史时勿把该条当新 user turn。

### 验收

- [ ] 续聊后会话列表 **无** 假 user 气泡；turnCount 不因续接 +1。

---

## 4. turnDurations 按「整轮发送」一条

### 现象

4 条用户消息，`turnDurations` 9 条（含 1053ms、5405ms 碎片）——计时 bug 导致多次 complete/stop。

### 目标

- `recordCompletion` 仅在 **真正终态** 写一次：`result` / 用户 STOP / session_error。  
- 工具循环中间 **软停** 不写 turnDurations。  
- 与 RT 规格一致：startedAt 不硬清 → 也不应中间 recordCompletion。  
- 若已有碎片 meta：加载时 **不** 合并（避免改历史）；新跑会话符合即可。

### 验收

- [ ] 一轮多工具 run：完成后 meta 只有 **1** 条新 turnDuration，ms ≈ 墙钟全程。

---

## 5. 子代理 stub tool_result 与卡片耗时

### 现象

Agent launcher→tool_result **9–23ms**；真实子代理 **52–218s**。若 UI 用 stub 时刻，入口卡/详情页显示「秒完」。

### 目标

- 子代理 **running** 态：到 parented 消息末条或 task_notification 才 completed。  
- 耗时 = 末条 parented `createdAt` − 派发时刻（审计算法）。  
- **不用** launcher 的 tool_result 时间作完成时间。

### 验收

- [ ] 派 Agent 60s+：入口卡 running 至少 60s，completed 后耗时与体感一致。

---

## 6. 优先级与 brief

| 项 | 优先级 | 建议 |
|----|--------|------|
| §1 关窗≠停止 | P1 | 窄改 AskUser + Chat，可 kscc |
| §2 文案 | P1 | prompt 改 `execution-mode-prompt.ts` |
| §3 续聊摘要 | P1 | 窄改 shared + session-turn-model |
| §4 turnDurations | P1 | 依赖 RT 已合，查 recordCompletion 调用点 |
| §5 子代理耗时 | P2 | subagent-ui-model / SubagentEntryCard |

实现时可拆 brief：`SESSION-UX-RESIDUAL-brief.md`（待写，派工前再开）。
