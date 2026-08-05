# CL5 Brief — 思考链出完即消失 + 不流畅

> 用户反馈：思考链输出完就消失，整体不流畅。  
> 派工：本机 `kscc -p`（不要用 Cursor Task）。

## 根因（已定位）

1. **致命**：`tool_execution_start` 会推一条**仅含 `tool_use`** 的 `sdk_message`（无 thinking）。  
   `Chat.tsx` 对**任何** `sdk_message` 都 `resetStreamState()` → 会话级 `streamState.thinking` 被清空。  
   此时落盘消息里还没有 thinking 块 → 过程区思考瞬间消失。  
   直到很晚的 `turn_end` 全量 assistant 才可能再带回来（中间空白 =「出完就没了」）。

2. **加重**：`turn_end` / `result` 再次清 state；live→idle 后过程组 ~0.9s+3s 自动折叠，思考缩成一行标题，体感像「消失」。

3. **不流畅**：stream→落盘/工具卡插入时 thinking 行 `isLive` 翻转、SmoothStream 停写、过程组 expand 状态随 remount 抖动。

## 目标

- 思考一经流式出现，**在整轮结束前不得被清空**；工具开始后仍可见完整思考。
- 落盘后思考留在过程组，可折叠但不「突然没了」。
- 流式思考尽量丝滑：禁止因 tool-only 中间消息把 thinking 打没。

## 必改契约

### A. `resetStreamState` 不得在 tool-only 中间态清 thinking

`Chat.tsx` `sdk_message` 分支：

- 若新消息**只有** `tool_use`（无 thinking / 无 text），**保留** `streamState.thinking`（text 可按需保留或清，优先保留 thinking）。
- 仅当消息已含非空 `thinking` 块（或回合真正结束：`stop_reason` / `turn_end` / `result`）时，才清 `streamState.thinking`。
- 清 text 的条件可对称：消息已含交付 text 或回合结束再清。

建议抽纯函数（便于单测），例如：

```ts
shouldClearStreamThinking(msg): boolean
shouldClearStreamText(msg): boolean
```

### B. 过程组：思考刚结束不要秒折

- live→idle 后，若过程组含 thinking：拉长 settle 或本轮默认保持展开更久（例如 settle 2–3s，或有 thinking 时不自动折、只显示「点击收起」）。
- 用户手动 toggle 仍优先。
- **不要**为修消失而禁止折叠；禁止的是「内容从 DOM 里删掉」。

### C. 稳定 key / 少 remount

- 流式 thinking 与落盘 thinking 续写同一 process key（已有 `stream-thinking` 逻辑，回归测一下 tool 插入后仍在）。
- 避免 tool-only `sdk_message` 导致 turn key 乱跳（检查 `groupItemsIntoTurns`）。

## 主要文件

- `apps/electron/src/renderer/components/chat/Chat.tsx`
- `apps/electron/src/renderer/components/chat/stream-item-model.ts`（或新建 `stream-state-clear.ts` 纯函数）
- `apps/electron/src/renderer/components/chat/ProcessGroupView.tsx` / `process-group-model.ts`
- 对应 vitest

## 验收（必须自动化）

1. 累积 `stream_thinking_delta` → 再来一条仅 `tool_use` 的 `sdk_message` → **thinking 字符串仍在**（state 或 presentation process）。
2. 随后 `turn_end` 全量 assistant（含 thinking+tool）→ 过程区仍有 thinking，无空窗。
3. 纯 thinking→text 无 tool：落盘后过程/回答符合 Checkpoint 2，thinking 不进回答区但过程区可见（或折叠头能看出有思考）。
4. typecheck + 相关 vitest 绿。

## 不做

- 不改 Pi adapter 事件协议（可只在渲染层修；若必须改 adapter 需说明）
- 不升 AgentSession、不搬 Proma
- 不 commit / push

## 交付

改动文件、测试命令与结果、手测步骤（思考→工具→回答）、已知风险。
