# 回归规格 — Chat 写拦仍打断 + 进度短总结不实时显示

> 日期：2026-08-07  
> 角色：总监规格。子代理据此只读摸底 / 再按 brief 修。  
> 用户原话：Chat 下 Write 仍导致会话中断，出现 `The user doesn't want to proceed with this tool use...`；学 Cursor 的「每段思考后落盘一句阶段性总结」，但总结总要等会话完成才显示。

---

## 1. 症状（验收对照）

### A. Chat 写操作仍打断会话

- 会话 `executionMode=chat`
- 模型调用 `Write`（或等价写工具）
- 用户看到英文控制文：`The user doesn't want to proceed with this tool use. The tool use was rejected... STOP what you are doing...`
- 会话被中断，体感像「权限又炸了」

**期望：**

1. Chat 下写工具在 `canUseTool` **服务端硬拦**，不得弹「用户点允许/拒绝」那条 Cursor 拒工具路径。
2. 硬拦写盘 → 整轮停 + **中文** `chat_mode_blocked` Banner（切 Work 引导）。
3. 工具结果 / 控制文若必须落盘，不得用上述英文 Cursor 拒工具原文糊用户脸；至少 UI 侧折叠为控制消息 + Banner 主导。

### B. 阶段性进度总结不实时显示

- concise 模式，学 Cursor：`思考 → 进度短文 → 阶段工作 → 进度短文 → … → 最终正文`
- 实际：中间「进度短文 / 阶段性总结」**流式过程中看不见**，会话结束后才突然出现。

**期望：**

1. 工具间 / 思考段间的 text，在 **live** 时即以 `narrative.tone=progress` 可见（可打字机）。
2. 回合结束后尾部升 `final`；中间 progress **不得**等到 `turn_end` 才首次出现。
3. 不得再出现 progress 卡片闪一下被 final 同 uuid 替换（H08）；也不得整段憋到结束才 dump。

---

## 2. 已知线索（勿重复空转）

| ID | 线索 | 路径 |
|----|------|------|
| P1 | Chat 硬拦在 bypass 之前；`isChatModeHardStopTool(Write)=true` → `chatModeBlockHandler` interrupt | `permission-service.ts` / `permission-rules.ts` |
| P2 | 英文拒工具文是 SDK 控制 user 消息哨兵 | `session-turn-model.ts` `isSdkControlUserMessage` |
| P3 | 工作树未提交：kscc `_partial` 透传 + partial 不落盘 + SmoothStream 子串兜底 + presentation 对 partial 不抽空 streamingText | `kscc-message-adapter.ts` / `session-service.ts` / `useSmoothStream.ts` / `session-turn-model.ts` |
| P4 | H08：partial 不带 `_partial` → progress 闪 → final 替换；与「结束才看见」可能同根或相邻 | `investigation/kscc-stream-flush/hypotheses.tsv` |
| P5 | concise：`i < lastToolIdx \|\| isLive` → progress | `concise-timeline-model.ts` ~548-552 |

---

## 3. 本轮不做

- 不删 Chat 硬拦语义、不自动切 Work
- 不升 AgentSession / 不搬 Proma 整层
- 不擅自 `git commit` / push（除非用户另指令）
- 不用 Cursor Task/explore 子代理（额度）；只用本机 `kscc -p`

---

## 4. 派工

| Agent | Brief | 产出 |
|-------|-------|------|
| A 权限根因 | `REGRESS-A-chat-write-interrupt-brief.md` | 根因报告 + 最小修复（若已定位） |
| B 进度显示 | `REGRESS-B-progress-live-brief.md` | 根因报告 + 最小修复；与未提交 partial 修复交叉验收 |
