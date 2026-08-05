# S1+S2 实现规格：单真源流式（Proma 骨架 + Reasonix 思考永驻）

> 基线：`docs/dev/core-loop/STREAM-SKELETON-AUDIT.md`  
> 派工：本机 `kscc -p`。不 commit / 不 push。  
> 目标：做一版**可跑**的单真源流式，治「思考出完就消失」。

---

## 目标态（必须做到）

```
同一 uuid 的一条 assistant 消息原地长（partial → final）
content[]：thinking / tool_use / text 并列长大
渲染只读这一条序列（groupIntoTurns）
思考只折叠，不因 tool / turn_end 被删
```

---

## S1 — Pi 适配器

文件：`apps/electron/src/main/lib/adapters/pi/pi-agent-adapter.ts`（及相关单测）

### 必做

1. **`message_update`**：把当前 partial assistant **转成完整 `sdk_message`**（`piAssistantToIR`），带**稳定 uuid**（与 turn_end final 同源），并标记 partial（若 IR 无 `_partial` 字段，可用 `stop_reason` 缺失表示仍在流式；或在 message 上挂可序列化标记，渲染层能识别）。
2. **思考必须在这条消息的 `content[]` 里**（`type:'thinking'`），不是只发 `stream_thinking_delta`。
3. **`stream_thinking_delta` / `stream_text_delta`**：可保留作加速，但**不得**再当思考唯一真源；若保留，须与 partial 消息内容一致。
4. **`tool_execution_start`**：禁止再推「只有 tool_use、无 thinking」的孤儿 assistant。  
   - 优先：把 tool_use **合并进当前 partial assistant 的 content[]** 再 upsert 同一 uuid；  
   - 或：等 `turn_end` 全量消息（已含 thinking+tools）再推，过程中用既有 tool 进度事件但不覆盖思考。
5. **`turn_end` / `message_end`**：同 uuid **替换**为 final（带 `stop_reason`）。

### 参考

- Proma：`pi-agent-adapter.ts` `message_update` → coalesce → convertPiMessage partial；`useGlobalAgentListeners` uuid upsert  
- 路径：`C:\Users\loumi\Desktop\AI\Proma\apps\electron\src\main\lib\adapters\pi-agent-adapter.ts`

---

## S2 — 渲染

文件：`Chat.tsx`、`session-turn-model.ts`、`stream-item-model.ts`、`AssistantTurnView.tsx`（按需）

### 必做

1. **`sdk_message` assistant**：按 `uuid` **原地 upsert**（有则替换同 uuid item，无则 append）。禁止无 uuid 的 tool-only 覆盖上一轮已完成 assistant。
2. **思考展示以 message.content 的 thinking 块为准**。`streamState.thinking` 若仍存在：仅作「尚无 partial 消息时」的短暂兜底；一旦同 uuid 消息带 thinking 块，**以消息为准**，不再靠清 streamState 赌时序。
3. **禁止**在 tool / 中间 sdk_message 上 `resetStreamState` 把思考打没（最终可逐步废弃 streamState 当真源）。
4. process 块 key：优先用稳定标识（如 thinking 内容 hash 前缀 / tool id），避免 `think-${seq}` 随列表重编 remount。
5. live→idle：思考块留在 content；UI 只折叠（对齐 Reasonix：完成≠删除）。

### 参考

- Proma：`AgentMessages.tsx` persisted⊕live；`groupIntoTurns`  
- Reasonix：`reasoning` 字段永驻 + 折叠  

---

## 验收（自动化 + 手测）

### 单测

1. 模拟：thinking deltas → tool_execution（或合并后的 partial）→ 断言过程区/presentation **仍有完整 thinking 字符串**。
2. 同 uuid partial 再 final：items 中该 uuid **只有一条**，content 含 thinking。
3. typecheck 绿；相关 vitest 绿。

### 手测

1. 重启 Electron。  
2. 开启 thinking 的模型，问会触发工具的问题。  
3. 观察：思考流完 → 工具执行 → 最终回答；过程区**始终能展开看到思考全文**，无「出完即空」。

---

## 不做

- 不升 AgentSession  
- 不搬 Proma EventBus / 灵动岛  
- 不并行权限 / Chat-Work / idle 冲刺  
- 不 commit / push  
- 不再给 `shouldClearStreamThinking` 堆特例当作主方案（可删可废）

---

## 交付

改动文件列表、测试命令与结果、手测步骤、已知风险（尤其 kscc 核是否仍走 delta-only）。
