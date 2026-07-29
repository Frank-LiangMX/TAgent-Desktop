# [dev] Round 2 Brief — 子代理 UX 收口

> 主线总监 brief。开发代理（kscc / glm-5.2）按此执行。
> 范围：子代理可见性 + 积极性设置。不要做 MCP、记忆、错误恢复。

## 背景

dev.8 已接通两核子代理运行时，UI 仍是简化版：
- `task_started` / `task_notification` 被塞成普通 assistant 文本气泡
- **无** `task_progress` 处理
- `parentToolUseId` 只加左边框，**不可折叠/嵌套到父 tool**
- `buildSubagentDelegationPrompt('conservative')` **写死** conservative

## 目标（DoD）

1. **实时进度**：收到 `task_progress` 时更新同一任务卡片的进度文案/条，不新开一堆气泡
2. **任务卡片生命周期**：`task_started` 建卡 → `task_progress` 更新 → `task_notification` 收口（完成/失败/停止）
3. **父子嵌套（实用版）**：带 `parentToolUseId` 的 assistant 消息默认折叠在「子代理输出」区块，可展开/折叠
4. **积极性设置**：4 档 never / conservative / balanced / aggressive 可选并持久化；kscc system append 读该值（不再写死）
5. typecheck + 相关单测通过

## 实现指引

### A. Chat 流事件：任务卡状态机

文件：`apps/electron/src/renderer/components/chat/Chat.tsx`

扩展 `DisplayItem`（或旁路 state）支持：

```ts
type TaskCardState = {
  kind: 'task_card'
  taskId: string
  description: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  lastToolName?: string
  summary?: string
  progressText?: string // 来自 description / lastToolName / elapsed
}
```

事件映射：
- `task_started` → upsert 卡（running）
- `task_progress` → 按 taskId/toolUseId 更新 lastToolName / progressText（**不要**每次 append 新 message）
- `task_notification` → status + summary

渲染：独立小卡片（圆角边框 + 状态色 + 可选 indeterminate/进度文案），放在消息流中。

### B. MessageView 嵌套折叠

文件：`MessageView.tsx`（及必要时 `Chat.tsx` 分组逻辑）

最小可用方案（优先简单）：
- 对 `message.parentToolUseId` 的 assistant：默认 `collapsed=true` 的 details/折叠头
- 折叠头：「子代理 · 点击展开」+ 一行摘要（首段 text 截断）
- 展开后现有左边框样式保留

可选增强（时间够再做）：按 parentToolUseId 把子消息挂到父 tool_use 块下方。

### C. subagentEagerness 设置

1. **类型**：在 `AgentSessionMeta` 加可选  
   `subagentEagerness?: 'never' | 'conservative' | 'balanced' | 'aggressive'`  
   默认 `conservative`

2. **主进程**：`session-service` 构造 kscc opts 时  
   `buildSubagentDelegationPrompt(meta?.subagentEagerness ?? 'conservative')`  
   Pi 核若有同等 system 注入点一并接上；没有就至少 kscc 接通并在注释标明。

3. **IPC**：可复用 `UPDATE_SESSION_META` / 现有 updateSessionMeta；若无热更新能力，会话级下次发送生效即可。

4. **UI**：在 Chat 输入区 footer（靠近 `PermissionModeSelector`）或设置页加紧凑 Select/Segmented：  
   从不 / 保守 / 均衡 / 积极  
   变更后 `updateSessionMeta({ subagentEagerness })`。

### D. 测试

- 纯函数：eagerness 默认值 / meta 合并 / task 卡 reducer（若抽成 model 文件）
- 路径建议：  
  `apps/electron/src/renderer/components/chat/subagent-ui-model.ts` + `.test.ts`  
  或 `task-card-model.test.ts`

## 约束

- 不要 git commit/push（总监 checkpoint）
- 不碰 MCP / 渠道 / 打包
- 中文注释可保留；UI 文案中文
- 最小可用优先，别上大重构虚拟列表

## 关键文件

- `Chat.tsx` — 流事件
- `MessageView.tsx` — 嵌套 UI
- `PermissionModeSelector.tsx` — UI 风格参考
- `subagent-definitions.ts` — eagerness prompt
- `session-service.ts` — 注入 eagerness
- `packages/shared/.../agent.ts` — AgentSessionMeta / AgentEvent
