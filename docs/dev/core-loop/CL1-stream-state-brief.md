# CL1 Brief — 流式状态与消息分离（W1）

> 规格：`docs/dev/core-loop/00-SPEC.md` §5 + `docs/dev/streaming-rework/00-SPEC.md` §3.1  
> Checkpoint 2 拆分契约必须保留：`docs/dev/streaming-rework/01-CHECKPOINT2-SPEC.md` §2

## 目标

```
items: DisplayItem[]              // 只放已落盘消息 / taskCard
streamState: { text, thinking }   // 会话级，独立于 items
```

- `stream_text_delta` / `stream_thinking_delta` **只**累加 `streamState`，永不因 delta 创建/修改 `items` 元素
- 段边界清空 `streamState`：`tool_start`、`turn_end`、新用户输入
- 完整 assistant `sdk_message` 到达：先推进 `items`，**同一批 React 更新**里清对应 `streamState`（禁止「已清流式、未挂消息」空帧）
- live 轮回答正文 / 思考取 `streamState`，不依赖 uuid 绑定 DisplayItem
- `buildTurnPresentation` 的 `canSplit` 逻辑保持 Checkpoint 2（thinking+text 无齐备 tool 时整轮留过程组）

## 主要文件

- `apps/electron/src/renderer/components/chat/Chat.tsx`
- `apps/electron/src/renderer/components/chat/stream-item-model.ts`（改造或瘦身）
- `apps/electron/src/renderer/components/chat/session-turn-model.ts`
- `apps/electron/src/renderer/components/chat/AssistantTurnView.tsx`
- 相关 vitest（新增/改写覆盖验收）

## 验收（必须有自动化测试）

1. 一串无空占位、先于正文的 `stream_thinking_delta` → 思考累积可见、无丢弃
2. partial uuid 每条都不同 → turn/DisplayItem key 稳定、不因 delta 新建 item
3. streaming + thinking + text、尚无 tool → 整组 process，回答区空
4. 工具齐 + 尾部 text → text 进回答区；完整消息落盘那一帧无闪空
5. `bun run typecheck` + 相关 vitest 全绿

## 不做

- 不升 AgentSession、不搬 Proma EventBus、不加 Streamdown
- 不改权限/Chat-Work 默认（CL3/CL4 另派）
- 不做 idle 看门狗（CL2）
- 不 commit / 不 push（总监 checkpoint）

## 交付

改完后简短回报：改了哪些文件、测试命令与结果、已知风险。
