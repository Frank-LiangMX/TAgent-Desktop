# FIX · CLI 子代理详情页有消息

> 总监 brief。实现后单测 + 不 git commit。

## 问题

CLI 工人 `task` 成功时主会话有 tool_result，但 `parentToolUseId` 消息数为 0 → 详情页「子代理尚未产生消息」。

渲染层已支持：`Chat.tsx` 对带 `parentToolUseId` 的 `sdk_message` 静默 append。缺的是 **主进程 CLI 路径不推这些消息**。

## 改动

### 1. `kscc-stream-observer.ts`

`onLine` 返回值扩展：

```ts
{
  lastToolName?: string
  toolUse?: { id: string; name: string; input: Record<string, unknown> }
  textChunk?: string  // 本行 assistant text 块拼接
  toolResult?: { toolUseId: string; content: string; isError?: boolean }
}
```

- `assistant` + `tool_use`：填 toolUse（id/name/input）
- `assistant` + `text`：照旧累积 + 返回 textChunk
- `user` + `tool_result`：解析 toolUseId/content/is_error（当前忽略，需启用）

### 2. `run-kscc-worker.ts`

```ts
onToolUse?: (t: { id: string; name: string; input: Record<string, unknown> }) => void
onToolResult?: (t: { toolUseId: string; content: string; isError?: boolean }) => void
onTextChunk?: (text: string) => void
```

在 `rl.on('line')` 里转发 observer 新字段。

### 3. `subagent-task-tool.ts`

- 将 `onTaskEvent` 扩展为可推 IR：新增参数  
  `emitPayload?: (p: TAgentDesktopStreamPayload) => void`  
  或把现有 sink 改为统一 `emitPayload`，生命周期事件包成 `{ kind:'tagent_event', event }`。
- **CLI 分支**内：
  - tool 开始 → `emitPayload({ kind:'sdk_message', message: assistant with parentToolUseId=toolUseId, content:[{type:tool_use,...}], uuid: cli-${toolUseId}-${id} })`
  - tool 结果 → `user` 消息 parentToolUseId + tool_result 块
  - 结束 → 再推一条 **final** assistant：`stop_reason: 'end_turn'`，content text = summary（完整报告），uuid 固定 `cli-${toolUseId}-final`
  - modelId 用 worker.defaultModel 或 `'kscc'`
- 入口卡 task_* 仍走 tagent_event（现有 onTaskEvent 或 emitPayload）

### 4. `pi-agent-adapter.ts`

`createTaskTool` 注册处：`emitLive` 同时服务 tagent_event 与 sdk_message：

```ts
const emitPayload = (p) => {
  if (entryRef?.emitLive) entryRef.emitLive(p)
  else entryRef?.pendingSystemMessages.push(p)
}
// 生命周期仍可用 emitPayload({kind:'tagent_event', event})
```

## 验收

- [ ] 单测：observer 解析 tool_use/tool_result；可选 task 工具 mock emit 被调用
- [ ] 手测路径：外渠 + CLI 开 → task → 详情页不再空，能看到文本和/或工具行
- [ ] 主时间线不刷子代理全文（Chat 已对 parented 静默 append）
- [ ] 写 `FIX-detail-messages-DONE.md`
- [ ] 不 git commit

## 禁止

- 大改 Chat 渲染
- 改设置页
