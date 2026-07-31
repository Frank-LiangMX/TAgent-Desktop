# Proma 消息与流式行为调研报告

> 目的：对照 Proma（`F:\Proma`）的会话数据模型与渲染管线，诊断 TAgent-Desktop 当前「改 UI 越改越乱」的根因，给出可执行的架构收敛方向。  
> **本报告只做调研与方案边界，不继续零敲碎打改 UI。**

---

## 1. 结论摘要

| 维度 | Proma | TAgent-Desktop（现状） | 差距 |
|------|--------|------------------------|------|
| 消息真源 | Agent：**SDKMessage[]** 一条链路 | IR `TAgentMessage` + 独立 `stream_*_delta` 双通道 | 双源抢渲染 |
| 流式模型 | **快照 / 累积全文** + uuid 原地替换 | **delta 追加** 到 DisplayItem，收口不清占位 | 双份正文 |
| Turn 语义 | `groupIntoTurns`（session-core 真源） | 渲染层自造 `groupItemsIntoTurns` | 语义不完整、与落盘脱节 |
| 工具 UI | 语义短语行 + 结果按 `tool_use_id` 挂靠 | 徽章墙 / 结果气泡 / 过程组半吊子 | 像调试器 |
| 模型铭牌 | 每 **assistant-turn 一次**（MessageHeader） | 每条 assistant message 一次 → 中间反复插 | 污染主线 |
| 防重复 | 稳定 key、尾部 overlap 替换、partial upsert、快照 last-wins | 流式占位不删 + 最终消息再 append | 全文/碎字双份 |

**一句话：** Proma 的 Agent 会话是「**SDK 转录 → 分组 Turn → 一个 Turn 一个外壳**」；流式只是同一条逻辑消息的**生长快照**，不是 UI 自己再拼一份 delta 时间线。Desktop 把「过程 delta」和「落盘消息」当成两条时间线叠加，所以会双份文字、工具刷屏、铭牌乱插。

---

## 2. Proma 整体双轨（先分清 Chat vs Agent）

Proma 有两条产品路径，**不要混抄**：

### 2.1 Chat 模式（简单对话）

- 主进程：`chat-service` + Provider Adapter SSE  
- 流式：IPC `onStreamChunk` → 渲染侧 **`content = content + delta`**（累积全文）  
- 平滑：`useSmoothStream({ content: 完整累积串, isStreaming })`  
  - 入参是**完整 content**，内部用 `prevContent` 算新增 delta，再逐字出队  
  - **不是**把每个 chunk 再拼一次显示缓冲  
- 完成：先 `streaming=false` 但**保留 content 作过渡气泡** → 刷新持久化消息 → **加载完成后再清流式状态**  
  - 专门避免：「流式气泡消失 ↔ 历史还没到」的空档与双渲染  

参考：`apps/electron/src/renderer/hooks/useGlobalChatListeners.ts`、`packages/ui/src/hooks/useSmoothStream.ts`、`ChatMessages.tsx`。

### 2.2 Agent 模式（工具循环，Desktop 应对齐这条）

- 主进程：Agent Orchestrator + Claude SDK / Pi SDK  
- 渲染真源：**SDKMessage 序列**（持久化 JSONL + 实时 live 列表）  
- UI：**不**把每个 text_delta 当独立 DisplayItem 堆栈  
- 分组：`@proma/session-core` 的 `groupIntoTurns`（与 CLI/export 共用，**唯一真源**）

参考：`useGlobalAgentListeners.ts`、`AgentMessages.tsx`、`SDKMessageRenderer.tsx`、`packages/session-core/src/group.ts`。

---

## 3. Proma Agent：数据与流式契约

### 3.1 事件进渲染层

`useGlobalAgentListeners` 对 `payload.kind === 'sdk_message'`：

1. 跳过 `prompt_suggestion` / 部分 system 进度（不进转录）  
2. 跳过 `isReplay`（防与持久化重复）  
3. 写入 `liveMessagesMapAtom[sessionId]`  
4. **UUID 去重 / partial upsert**（Pi 关键）：
   - 同一 `uuid` 且带 `_partial` → **原地替换**，不是 append  
   - 最终 `message_end` 同 uuid 再替换为终态  
5. 非 partial 且 uuid 已存在 → **忽略**（防队列乐观注入双写）

主进程侧 Pi：`message_update` 打 `_partial: true`，`message_end` 出终态（见 `pi-message-adapter.ts`、`pi-agent-adapter.ts`）。

**含义：** 流式期间列表里对「同一条逻辑 assistant」只有**一份**，内容在变长；不是「一堆半成品 + 一份成品」。

### 3.2 持久化 + Live 合并

`AgentMessages`：

```
allSDKMessages = merge(persistedSDKMessages, liveMessages)
```

流式中：简单 concat。  
流式结束后：按**有序尾部 overlap**（稳定 key）做尾替换，避免全局内容去重误伤历史重复问答。

加载完后**清空 live**，与 Chat 的「过渡再清」同一思想：  
**过渡期可以短暂双源，但必须有明确的「谁先谁后 / 何时只留一边」。**

### 3.3 Turn 分组（session-core）

`groupIntoTurns(messages)` 规则（`packages/session-core/src/group.ts`）：

1. **真正用户输入**（有 text、非 synthetic、非 tool_result）→ 独立 `user` group  
2. `assistant` + 中间 `user(tool_result)` + 再 `assistant`… → **一个 `assistant-turn`**  
3. 压缩边界等 system → 独立  
4. result / tool_progress 等归入当前 turn  
5. 后处理：相邻**同模型** assistant-turn 可合并（子代理碎片）  

每个 `assistant-turn` 带：

- `assistantMessages[]`（可含多行快照）  
- `turnMessages[]`（含 tool_result，供结果查找）  
- `model` / `createdAt` **各一份**

导出/CLI：`toTranscript` 再对 `assistantMessages` 按 **message.id last-wins** 去重快照，消除「单字拼接 / 重复段落」。

### 3.4 单 Turn 渲染结构（用户看到的样子）

`AssistantTurnRenderer` 外壳：

```
Message
  MessageHeader   ← 模型名 + 时间 + logo（只一次）
  MessageContent
    process-group(s)  ← thinking + tool_use（可折叠）
    final text block  ← 交付正文
    footer            ← 耗时 / 用量 / 操作
```

过程区（`ProcessBlockGroup` + `buildAssistantTurnRenderItems`）：

- 过程块与**末尾连续 text** 拆开  
- 流式中过程可整组收进 process-group  
- 完成后可自动折叠  

工具行（`ContentBlock` + `tool-phrase`）：

- **语义短语**：「读取 a.ts」「执行 ls -la」  
- 结果用 `tool_use_id` 在 allMessages 里查，**不单独画 user「结果」气泡**  
- 展开才看结构化结果 / 入参  

---

## 4. Proma Chat 流式防闪的细节（可借鉴，勿套错层）

| 机制 | 作用 |
|------|------|
| `content` 累积全文 + useSmoothStream | 显示层不二次「全文+全文」 |
| complete 后保留 content 到 refresh 完成 | 防空档 |
| smoothContent 用 `streaming \|\| streamingContent` 守卫 | 防一帧双气泡 |
| resize=instant 过渡 | 防高度跳动 |

Agent 路径额外还有 **live vs persisted 尾部 overlap**，比 Chat 更复杂。

---

## 5. TAgent-Desktop 现状对照（为何「改不完」）

### 5.1 双通道叠时间线

当前大致是：

```
stream_text_delta  → DisplayItem{ streaming:true, streamingText+=delta }
stream_thinking_delta → 同上
sdk_message        → DisplayItem{ message }  // 往往不删 streaming 项
```

收口时若只 `streamingRef=null` 而不从 `items` **purge streaming 项**，则：

- turn 里同时有「流式全文」+「落盘全文」  
- UI 各渲染一次 → **整段回答双份**  
- 若 delta 语义与「全文快照」混用，还会出现**碎字级重复**观感  

这正是用户截图里「对话刚刚对话刚刚 / 确定确定」类污染的高概率来源（渲染叠层 + 错误拼接），不是「再加一个折叠」能根治的。

### 5.2 自造 Turn 与 Proma 真源不对齐

Desktop 在 renderer 做了 `groupItemsIntoTurns` / `buildTurnPresentation`：

- 没有 uuid / message.id 快照去重  
- 没有 live/persisted 合并协议  
- tool_result 用户消息合并不完整时仍会漏成「用户选择」感  
- 过程 UI 从徽章墙改语义行仍是**表象修补**  

### 5.3 工具呈现哲学相反

| Proma | Desktop 曾出现的形态 |
|-------|----------------------|
| 活动流短语 | Bash / Read / 结果 徽章 |
| 结果挂在 tool 上 | 右侧/下方独立「结果」 |
| 过程可收，主线是回答 | 过程即主线，回答被淹没 |

### 5.4 改法陷阱

在错误抽象上继续叠：

- 折叠过程 → 展开仍是徽章  
- 语义行 → 双通道仍双份字  
- dedupeAnswerTexts → 治标不治本  

→ **「改下去没完没了」是架构信号，不是工程量信号。**

---

## 6. 建议的收敛方向（按阶段，勿并行乱打）

### 原则

1. **Agent 会话只认一种转录：有身份的消息列表**（可先继续用 IR，但必须有稳定 id / 与流式同一条链）。  
2. **禁止**「delta DisplayItem 时间线」与「最终 message 时间线」长期共存。  
3. **Turn 分组算法单点**（可抽到 shared/session-core 同类模块），渲染只消费 Turn。  
4. **工具结果永不作为用户气泡**；只按 tool_use_id 挂靠。  
5. **模型/时间元数据在 Turn 外壳一次**，不在 content 循环里插。  

### Phase A — 止血（小、可测）

- 任意 `sdk_message` / `result` / `turn_end`：**从 items 删除全部 streaming 占位**  
- 有落盘 assistant text 时：**禁止再渲染 streamingText**  
- 单测：stream 全文 + 同文 sdk_message → DOM/结构只出现一次  

（这是止住双份字的最小闭环；不解决工具哲学，但停止灾难。）

### Phase B — 对齐 Proma Agent 数据面

- 明确 Pi/kscc 是否输出 **partial 快照** 还是 **纯 delta**  
  - 若 partial：上 uuid + 原地替换（抄 Proma `_partial`）  
  - 若纯 delta：只允许**一个** live assistant 缓冲（累积全文），结束时 **replace 成一条** 消息，而不是 append 第二条  
- 持久化重载与 live 合并：尾部 overlap 或 id 去重  
- `groupIntoTurns` 提升为 shared 真源，CLI/测试共用  

### Phase C — 对齐 Proma Agent 呈现面

- `AssistantTurnRenderer` 级外壳：Header 一次 + ProcessGroup + 最终 text  
- `getToolPhrase` + 结果挂靠（已部分做，应绑在 Turn 渲染上，而不是旧 MessageView 双路径）  
- 删除「结果徽章 / tool_result 用户行」渲染路径  
- 过程默认折叠，主线只留用户问 + 助手答  

### Phase D — Chat 路径（若 Desktop 仍有非 Agent 对话）

- 单独走「累积 content + useSmoothStream + 完成过渡」  
- **不要**与 Agent 工具循环共用 DisplayItem 堆栈  

---

## 7. 明确「不要做什么」

1. 不要再在 MessageView / ProcessGroup 上打补丁式 CSS 掩盖双份内容。  
2. 不要再发明第三套「中间态 item」类型（compact / stream / ir / task 已经过多）。  
3. 不要把 Chat 的 chunk 累加逻辑直接套到 Agent 多步 tool loop。  
4. 不要在未统一 id/快照语义前做「智能 dedupe 文本」当主方案（可作兜底，不可作架构）。  

---

## 8. 关键文件索引（Proma）

| 主题 | 路径 |
|------|------|
| Turn 分组真源 | `packages/session-core/src/group.ts` |
| 快照去重 / 导出 | `packages/session-core/src/transcript.ts` |
| Live 累积 + uuid upsert | `apps/electron/.../hooks/useGlobalAgentListeners.ts` |
| 持久化∪live 合并 | `apps/electron/.../agent/AgentMessages.tsx` |
| Turn 渲染 | `apps/electron/.../agent/SDKMessageRenderer.tsx` |
| 过程组 | `apps/electron/.../agent/ProcessBlockGroup.tsx` |
| 工具短语 | `apps/electron/.../agent/tool-phrase.ts` |
| 工具行 | `apps/electron/.../agent/ContentBlock.tsx` |
| Chat 流式 | `hooks/useGlobalChatListeners.ts` + `useSmoothStream` |
| Pi partial | `main/lib/adapters/pi-message-adapter.ts` |

---

## 9. 与当前 Desktop 改动的关系

近期 Desktop 已尝试：

- rail 插件 IA、权限白名单、项目内读默认放行  
- turn 分组、过程折叠、语义工具行  

这些**方向与 Proma 一致的部分应保留为 Phase C 素材**；  
**数据面仍是双通道**时，任何 UI 改进都会被「双份流 + 多 message append」打穿。

**下一步应开一条「Agent 消息管线对齐 Proma」专项**，按 Phase A→B→C 做，而不是继续在会话页上零散改组件。

---

## 10. 建议的验收标准（专项做完才算完）

1. 一次用户提问、多轮工具：屏幕上**只有一个**模型铭牌、**一段**最终回答。  
2. 流式过程中刷新/结束：回答字数与落盘一致，**无整段复制粘贴感**。  
3. tool_result **从不**出现在「用户气泡」样式里。  
4. 过程折叠态一行摘要；展开为语义短语列表，点开才有 I/O。  
5. 重载历史与刚结束的 live 合并无双条。  
6. 单测覆盖：partial 替换、streaming purge、turn 分组、tool 挂靠。  

---

*调研范围：`F:\Proma` 主路径（Agent + Chat 流式）；对照 `F:\TAgent-Desktop` 当前 Chat/DisplayItem 实现。未要求复制 Proma 代码，只对齐契约与分层。*
