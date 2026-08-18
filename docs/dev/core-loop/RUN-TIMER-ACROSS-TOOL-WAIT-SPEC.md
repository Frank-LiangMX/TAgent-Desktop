# 运行计时：工具等待不停表、不从零开始

> 日期：2026-08-18  
> 现象：长任务中每次 SDK `turn_end`（工具循环间隙，含普通 Read/Bash，不只子代理）都会让主会话 UI「停一下再继续」，运行时间从 0 重计。  
> 对照：Codex 等回调时记下已走时长，继续时叠加，不换新一轮。

## 根因（代码，待会话落盘交叉验证）

1. 助手一轮出 `tool_use` 后 SDK 发 `turn_end`（单轮结束，整次 query 未完）。
2. `Chat.scheduleRunStop`：3s 宽限无新 delta → **软停** `running=false`；再 2s → **硬停** 清 `startedAt` / `startedAtMemory`。
3. 任意工具（Read/Bash/Edit/Agent）超过约 5s 都会硬清计时起点。
4. 下一轮 delta `adopt` 没有记忆就用 `Date.now()` → pill / 铭牌从 0s。
5. `useLiveElapsedMs` 在 `isLive=false` 时清 `anchorRef`，复活后锁新起点。
6. 子代理 parented 消息被故意跳过 adopt / 不刷新 `lastStreamEventAt`；主进程若已 idle，看门狗 20s 再硬清一次。

「没派子代理也停一下」= 普通工具间隙同样走 `turn_end` → 软停（停止键/过程区抖）→ 可能硬停（计时归零）。

## 目标行为

- **同一用户回合**（发送 → 真正 `result` / 用户停 / 出错）：`startedAt` 只记一次。
- 工具循环 / 等子代理回调：**不要**当新一轮；不要硬清记忆。
- 计时：**墙钟连续**（`now - 原 startedAt`）。等工具期间 pill 继续走，不从零。这比「冻结再叠加」更简单，视觉上等于 Codex「记下已走时长再往上加」。
- 软停只用于「真的可能结束了」的宽限（无未完成 tool_use、无 running taskCard）。未完成工具时 **保持 running**，禁止停一下再继续。
- 真结束仍靠：`result` / `session_error` / 用户停止 / 看门狗（主进程 idle **且** 无在途工具）。

## 不做

- 不改 Pi/KSCC 工具循环核
- 不把子代理时长单独加进主 pill（主 pill = 主会话墙钟）
- 不 commit / push

## 落地（2026-08-18）

- `turn_end` 若仍有未配对 tool_use / running taskCard / 圆桌进行中 → **不安排停表**。
- 无在途工作时仍 3s 软停，但 **不再 2s 硬清 startedAt**（硬清只走 result / 用户停 / 出错 / 看门狗）。
- `adopt` 记忆优先于 `Date.now()`；工具 `tool_start` / `task_*` 刷新看门狗。

**状态**：代码已在工作区（`session-run-inflight.ts`、`Chat.tsx`、`session-run-atoms.ts`、`useGlobalSessionRunSync.ts`）；**待打包实机验证**。总览见 [SESSION-RUN-EXPERIENCE-MASTER.md](./SESSION-RUN-EXPERIENCE-MASTER.md)。

## 验收

1. 一轮里多次 `turn_end` + 工具 >5s：pill 单调增加，不跳回 0s。
2. 无未完成 tool_use 时才允许软停（硬清仅终态/看门狗）。
3. 真正 `result` 后 pill 消失，耗时落在该 assistant-turn。
4. 单测：`session-run-inflight.test.ts`、`session-run-atoms.test.ts`（11 项已通过）。

