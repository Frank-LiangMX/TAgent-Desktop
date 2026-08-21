# 运行中引导支持附件设计

## 1. 背景

当前会话运行中，用户可以先发送一条消息到队列，再选择“引导”，让 Agent 在不中断当前运行的情况下处理补充指令。

普通发送已经支持附件，但“引导”使用的是独立的纯文本链路。点击队列项的“引导”后，当前实现只调用 `submitSteer(item.text)`，因此附件不会进入引导 IPC，也不会进入 Agent 的输入内容。

当前行为：

- 队列预览阶段可以看到附件；
- 点击“引导”后只传递文字；
- 主进程落盘的引导消息只有文本块；
- UI 中最终的引导气泡没有附件；
- KSCC 实时引导和 Pi 下一轮引导都无法读取图片/文件内容。

相关现状代码：

- `apps/electron/src/renderer/components/chat/Chat.tsx`：`steerQueueItem` 只向 `submitSteer` 传文本；
- `apps/electron/src/preload/index.ts`：`steerAgent` IPC 只接受字符串；
- `apps/electron/src/main/lib/ipc/session-service.ts`：`persistSteerUserMessage` 只构造文本块；
- `apps/electron/src/main/lib/agent/runtime/session-runtime.ts`：`steerMessage` 只发送字符串内容。

## 2. 目标

让运行中引导与普通发送具备一致的附件语义：

1. 用户点击“引导”后，附件不会丢失；
2. UI 立即显示带附件的引导消息；
3. Agent 确实能读取附件，而不是只有一个 UI 占位卡片；
4. KSCC 实时引导和 Pi 下一轮引导都支持附件；
5. 旧的纯文本引导调用保持兼容；
6. 引导失败时不应静默删除队列项或附件。

非目标：

- 不改变“引导不中断当前运行”的语义；
- 不重新设计普通发送附件链路；
- 不绕过网页或文件权限检查；
- 不把大文件内容直接通过多次 IPC 重复传输。

## 3. 设计原则

### 3.1 复用普通发送的附件模型

附件仍然先通过 `saveAttachment` 保存到会话附件目录，再在 IPC 中传递附件元数据：

```ts
{
  id: string
  filename: string
  mediaType: string
  localPath: string
  size: number
}
```

不把 base64 内容直接塞进引导消息或模型 prompt。这样可以避免大图片导致 IPC 和上下文重复膨胀。

### 3.2 UI 展示与模型输入必须同时成立

附件支持不能只做 UI 卡片。引导消息需要同时具备：

- `attachments` 元数据，用于消息记录和 UI 展示；
- 模型可见的附件路径/内容块，用于 Agent 读取；
- 原始文本引导，用于保持现有引导语义和回声去重。

### 3.3 两种运行内核统一输入语义

| 运行路径 | 当前行为 | 改造后 |
| --- | --- | --- |
| KSCC live steer | 长驻进程立即 enqueue 纯文本 | enqueue 文本 + 图片/文件内容块 |
| Pi pending steer | 保存纯文本，轮结束后自动新发 | 保存文本 + 附件，轮结束后自动发送 |
| UI/面板落盘 | 只保存文本块 | 保存文本块 + `attachments` |

## 4. 具体改造

### 4.1 共享类型

新增或复用一个引导附件类型，避免在 preload、renderer、main 中重复定义：

```ts
interface SteerAttachment {
  id: string
  filename: string
  mediaType: string
  localPath: string
  size: number
}
```

引导输入建议使用对象形式，避免继续扩展位置参数：

```ts
interface SteerAgentInput {
  sessionId: string
  message: string
  attachments?: SteerAttachment[]
}
```

同时保留旧调用形式一段时间，或在 preload 层统一转换，避免旧 renderer/测试调用直接失效。

### 4.2 Renderer：队列引导保存附件

`steerQueueItem` 目前拿到的队列项附件仍是前端草稿结构，包含 `data` 和可选 `previewUrl`。点击“引导”时应：

1. 先保存所有附件；
2. 取得主进程返回的 `localPath` 等持久化元数据；
3. 调用 `steerAgent({ sessionId, message, attachments })`；
4. 只有成功后才从消息队列删除该项；
5. 保存或引导失败时保留队列项，并提示失败原因。

可抽取复用普通 `sendQueued` 中的附件保存函数，避免两条路径产生不同的文件命名和清理逻辑。

### 4.3 Preload 与 App 类型

把 `steerAgent` 从：

```ts
steerAgent(sessionId: string, message: string)
```

扩展为：

```ts
steerAgent(input: SteerAgentInput)
```

同步修改：

- `apps/electron/src/preload/index.ts`；
- `apps/electron/src/renderer/App.tsx` 中的 `Window.electronAPI` 类型；
- 相关 mock、测试和调用点。

### 4.4 Main：引导消息落盘

`persistSteerUserMessage` 需要接收附件，并构造与普通用户消息一致的内容：

```ts
{
  role: 'user',
  content: attachImageBlocksToText(
    appendAttachmentPathsToPrompt(text, attachments),
    attachments,
  )
}
```

同时设置：

```ts
isSteer: true
attachments
```

这样可以保证：

- 面板 JSONL 保留附件元数据；
- renderer 收到的 `sdk_message` 能渲染附件；
- KSCC resume 数据不会丢失引导附件。

需要注意模型附录不应重复显示为第二条用户消息，继续复用现有的附件附录识别逻辑。

### 4.5 Main：KSCC 实时引导

扩展 `SessionRuntime.steerMessage`，接收已经保存好的附件元数据。构造 `SDKUserMessageInput` 时：

- 文本使用现有 `wrapSteerPromptForModel`；
- 使用 `appendAttachmentPathsToPrompt` 注入本地路径；
- 使用 `attachImageBlocksToText` 为图片生成模型可见的 image block；
- 保持 `type: 'user'`、`session_id` 和 `parent_tool_use_id` 完整。

如果底层 KSCC 的实时队列协议不接受图片 block，需要在适配层确认其支持的 content 结构；若只接受文本，则至少传递明确的本地附件路径，并将该限制记录为运行内核能力差异，不能在 UI 上伪装成已发送图片。

### 4.6 Main：Pi 下一轮引导

当前 `pendingSteerBySession` 是 `Map<string, string[]>`，需要改为保存结构化项：

```ts
interface PendingSteer {
  text: string
  attachments?: SteerAttachment[]
}
```

轮结束后合并文本时不能把附件丢掉。建议：

- 文本仍然合并成一条引导 prompt；
- 附件数组按顺序合并并去重；
- 调用 `handleSend` 时传入 `attachments`；
- 继续设置 `isSteer: true` 和 `skipUserPersist: true`，避免重复生成用户气泡。

## 5. 错误处理与生命周期

### 保存失败

- 不调用 `steerAgent`；
- 保留队列项；
- 显示“附件保存失败”；
- 不删除原始预览数据。

### 引导 IPC 失败

- 保留队列项和附件；
- 不显示成功状态；
- 允许用户再次点击引导或改为普通排队发送。

### 引导成功

- 删除队列项；
- 释放仅用于预览的 object URL；
- 不删除会话附件目录中的持久化文件；
- UI 立即显示引导消息及附件卡片。

### 会话停止或删除

Pi pending 引导的附件需要与 pending 文本一起清理引用。已经落盘的附件是否物理删除，遵循现有会话附件清理策略，不在本功能中新增危险删除。

## 6. 测试计划

### 单元测试

- `steerAgent` 输入可以携带附件元数据；
- `persistSteerUserMessage` 保留 `isSteer`、文本和附件；
- KSCC live steer 构造出带附件内容的 user message；
- Pi pending steer flush 时附件仍传给 `handleSend`；
- 多个引导合并时文本和附件顺序正确。

### Renderer 测试

- 队列项含附件时点击“引导”会先保存附件；
- 引导失败不会删除队列项；
- 引导成功后附件卡片仍出现在引导消息中；
- 普通排队发送行为不回归。

### 手工验收

1. 运行一个较长任务；
2. 输入文字并附加一张 PNG，回车加入队列；
3. 点击该项“引导”；
4. 确认当前消息区出现带图片附件的引导气泡；
5. 观察 Agent 是否能描述图片内容或读取文件内容；
6. 分别验证 KSCC live 和 Pi pending 两条路径；
7. 停止运行、重新打开会话，确认附件仍可见。

## 7. 完成标准

只有同时满足以下条件才算完成：

- 引导 UI 显示附件；
- 面板和会话历史重新加载后仍显示附件；
- Agent 输入中确实包含附件，而不只是附件文件名；
- KSCC 与 Pi 路径均有明确结果；
- 引导失败不丢队列项和附件；
- 普通发送、排队发送、编辑队列项行为不受影响；
- 相关单元测试通过，renderer 构建通过。

## 8. 推荐实施顺序

1. 抽取共享 `SteerAttachment` / `SteerAgentInput` 类型；
2. 抽取 renderer 附件保存函数；
3. 打通 preload、main 的结构化引导输入；
4. 先实现 UI 落盘和历史显示；
5. 实现 KSCC live steer 附件注入；
6. 实现 Pi pending steer 附件保留；
7. 补测试和手工验收；
8. 最后再打本地包。

