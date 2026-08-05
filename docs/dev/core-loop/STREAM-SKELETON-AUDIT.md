# 流式骨架审计：TAgent-Desktop vs Proma / Reasonix / Kun

> 2026-08-05。只读复核。独立二次审计与首版结论收敛：**不是再缺一个 if，是真源模型错了。**
> 根因：TAgent 把「过程 delta（`streamState`）」与「落盘消息（`items`）」当**两条时间线叠加**；三家参考全部是 **一条时间线在长**——思考/正文/工具在同结构的块/字段里原地累积，思考永驻只折叠、不清不删。

---

## A. 三家各自的「流式真源」

| 项目 | 流式真源（一句话） | 关键文件 |
|---|---|---|
| **Proma** | `liveMessagesMapAtom`（`Map<sid, SDKMessage[]>`）单结构；流式 = 同 `uuid` 的 `_partial` assistant **原地替换**，流式结束由磁盘 JSONL 同型 `SDKMessage[]` 接管。**思考/正文/工具都在这一条 assistant 的 `content[]` 里长大，互不覆盖。** | `apps/electron/src/renderer/atoms/agent-atoms.ts:314`；`apps/electron/src/renderer/hooks/useGlobalAgentListeners.ts:768-796`；`packages/shared/src/types/agent.ts:168-192,365` |
| **DeepSeek-Reasonix** | 单一 Wails 事件通道 `agent:event` → `WireEvent`（`kind` 区分 `"reasoning"`/`"text"`），reducer 规约成 per-tab `State` + `LiveStream`（`{id,text,reasoning,reasoningComplete}`）。`turn_done` 冻结进 `items[]` 的 assistant `reasoning` 字段。**reasoning 永不删，只折叠。** | `desktop/frontend/src/lib/types.ts:6-27,237-268`；`desktop/frontend/src/lib/useController.ts:1196-1213,1476-1489`；`desktop/frontend/src/lib/bridge.ts:651-655` |
| **Kun** | 事件溯源 `RuntimeEvent` 流（`assistant_text_delta`/`assistant_reasoning_delta` 同名 `ItemEvent`），单 reducer 按 `item.id` 做 `append-delta` upsert。**思考完成 = `status:'completed'`，item 留存，UI 默认折叠行。** | `kun/src/domain/runtime-event-reducer.ts:171-174,455-483`；`kun/src/loop/model-round-engine.ts:113-130`；`kun/src/contracts/items.ts:88-98` |

骨架铁律（三家共性）：
1. 同一逻辑消息只有一份（`uuid` / `id`）。
2. 思考是这份消息的**字段或 content 块**，不是「另一条时间线」。
3. 流式结束 = 同一份变 final，**不是「删掉流式再挂一份落盘」**。

---

## B. TAgent 当前真源 + 与三家差距

### TAgent 当前真源（双通道）
- **通道 A —— `items: DisplayItem[]`**（`Chat.tsx:208`）：落盘/中间态 `sdk_message` 载体，每条带 `message`/`streamingText`/`streamingThinking`/`streamUuid`/`streaming`（`Chat.tsx:139-160`）。
- **通道 B —— `streamState: {text, thinking}`**（`Chat.tsx:210`，`stream-item-model.ts:10-13`）：delta 累积缓冲，**不绑 uuid**，纯字符串。代码自注「delta 只累加 streamState，永不因 delta 创建/修改 items」（`stream-item-model.ts:5`）。
- **合流点**：`buildTurnPresentation({...turn, items}, {isLiveTurn, streamState})`（`AssistantTurnView.tsx:72-84` → `session-turn-model.ts:390-652`）的 `useMemo` **同时读两边**，`isLiveTurn` 时 streamState 覆盖 items 的 `streamingText/Thinking`（`session-turn-model.ts:436-442`），再 `resolveAnswerContent(answerFull, streamText)` 取更长前缀。

### 差距表

| 维度 | TAgent-Desktop | Proma | Reasonix | Kun |
|---|---|---|---|---|
| 真源数量 | **双**（`items` + `streamState`） | 单（`SDKMessage[]`） | 单（`State`+`LiveStream`） | 单（`RuntimeEvent` 流） |
| 思考/正文载体 | 分两通道：delta→`streamState.thinking`，落盘→items 的 thinking block | **同 message 的 `content[]` 两 block 并列** | 同 `WireEvent` 流 `kind` 分流，落 `live.reasoning`/`live.text` | 同事件流不同 `item.id`/`kind` |
| partial 合并 key | delta **无 key**（裸串）；items 用 `streamUuid`（需与终态同源，脆） | **`uuid` 原地替换、位置不变**（`useGlobalAgentListeners.ts:768-796`） | `live.id` append 到 buffer | `item.id` append-delta |
| 思考生命周期 | **无显式标记，靠 `shouldClearStreamThinking` 凭 `stop_reason`/内容推断**（`stream-item-model.ts:59-66`） | block 永驻 `content[]`，不推断 | 显式 `reasoningComplete`+`userOverridden`，只折叠不删（`Message.tsx:897-907,965-972`） | 显式 `status:'completed'`，item 留存 |
| 终态/reset | `turn_end`/`tool_start` 调 `resetStreamState` 清 `streamState`+`pendingThinkingRef`（`Chat.tsx:1316-1319`） | `message_end` 同 uuid 原地替换，不清前序 | `turn_done` 冻结 live→items，reasoning 写回字段，不丢 | 完成只改 `status`，不删 item |
| 正文归属 | `splitAnswer` 把尾部 text 在「过程区↔回答区」搬运（`session-turn-model.ts:495-507,531-539,623-634`） | block 各占其位，不跨区搬 | `item.text` 单字段 | item 各占其位 |
| 渲染通道 | 合流 `useMemo` 读双通道 | 单 store 派生 | 单 reducer 单 State 派生 | 单 reducer 派生 |
| 工具到达 | 另推 tool-only `sdk_message`（常不含 thinking） | 同 message `content[]` 增加块 | 同 `items[]` upsert tool 卡 | 同事件流另 item |

一句话：Desktop 把「过程 delta」和「落盘消息」当两条时间线叠加；三家都是一条时间线在长。

---

## C. 「思考出完就消失 / 不流畅」的结构性原因（3 条，非补丁）

1. **双写双通道抢渲染（根因）**。落盘 `sdk_message` 一帧内双 `setState`：`setItems` 升级 item（清 `streamingText/Thinking`），`setStreamState` 按 `shouldClearStreamThinking` 选择性清（`Chat.tsx:1145-1242`）。下一渲染 `buildTurnPresentation` 同时读两边合流：若 streamState 已被清、items 落盘消息又不带 thinking block（Pi `turn_end` 最终消息常只含 text/tool_use）→ 思考链瞬间从过程区消失。三家无此问题，因思考从不在「落盘」这一刻被清——它本就在同结构的块/字段里永驻。

2. **思考态无独立生命周期，靠内容推断**。`shouldClearStreamThinking`（`stream-item-model.ts:59-66`）在 `stop_reason` 终态**无条件**清 `streamState.thinking`，不检查落盘消息是否真带 thinking 内容。对照：Reasonix 显式 `reasoningComplete`+`completeLiveReasoning`（`useController.ts:1476-1489`），Kun `status:'completed'`（`model-round-engine.ts:113-130`），Proma 的 thinking block 在 `content[]` 天然永驻——都不靠「猜消息内容」定生死。

3. **`splitAnswer` 跨区搬运依赖 tool_result 到达时机**。`areToolsBeforeIndexCompleted` 在某轮 `tool_result` 到达瞬间由 false→true，尾部 text 从过程区外置到回答区，`answerOverlay`（`session-turn-model.ts:623-634`）反向剥过程区同源 text → 正文在两区之间跳。同时 process block 稳定 key 用 `think-${thinkingSeq}`/`text-${textSeq}`（`session-turn-model.ts:449-483`），序号随 items 增减变化 → 工具循环中同一段思考拿到不同 key → React remount → `useSmoothStream` 的 `prevContentRef` 失配 → 重复字/顿挫。

> 放大器：`purgeStreamingItems`（`stream-item-model.ts:110-112`）在落盘/`result`/`turn_end` 清所有纯流式占位；`turn_end` 后 3s `isLiveTurn` 宽限期内 streamState 已被 `resetStreamState` 清空（`Chat.tsx:1329`）→ 过程区思考空一拍。补丁式「tool-only 不清」只治标，骨架仍双源。

---

## D. 最小收敛方案：抄哪家的哪条契约

**主抄 Proma**（与 Desktop 同为 Electron + `sdk_message` + content blocks，结构最近、迁移最省）的「单 `SDKMessage[]` + `content[]` 块占位 + `uuid` 原地 upsert」契约；辅以 **Reasonix 的「思考只折叠不删 + 显式完成标记」** 作思考生命周期。

```
目标态：
  items/liveMessages: TAgentMessage[]（单一真源）
  流式：同 uuid 的 assistant 消息原地 upsert（_partial → final）
  content[] 内同时长大：thinking → tool_use → text（块各占其位）
  思考完成 = 显式标记（不靠 stop_reason 推断）
  UI：groupIntoTurns(这一条序列) 单源；过程区/回答区是只读派生视图，不搬数据
  禁止第二条 streamState 当真源（可降为派生缓存）
```

实施切片（只做这一条主链）：

| 步 | 做什么 | 不做 |
|----|--------|------|
| S0 | 冻结补丁：停止在 Chat 里继续堆「何时清 streamState」特例 | 再开 CL3/CL4 式外围 |
| S1 | Pi：`message_update` 推 **partial assistant sdk_message**（含 thinking 全文快照），稳定 uuid；delta 仅作可选加速，**不得**作思考唯一真源 | 升 AgentSession 大重构 |
| S2 | 渲染：live 列表 uuid upsert；`groupIntoTurns` 单源；删掉对思考的 `streamState` 依赖（或降为派生缓存）；block 稳定 key 用 block 自身 id，不随 items 重编号 | 搬 Proma EventBus / 灵动岛 |
| S3 | 工具：禁止 tool-only 消息覆盖/清空思考——工具块进**同一** partial/final assistant 的 `content[]` | 子代理嵌套流 |

验收：思考流完 → 工具开始 → 回答出现，过程区思考**始终可展开看到全文**；无「出完即空」；typecheck + 单测锁 uuid upsert。

---

## E. 本轮明确不要做

- ❌ 再给 `streamState`/`shouldClearStreamThinking`/`applySdkMessageToStreamState` 加分支、加边界判定、加「例外不清」特例——病根，不是修法。
- ❌ 再给 `splitAnswer`/`areToolsBeforeIndexCompleted`/`answerOverlay` 加条件——跨区搬运本身就是错。
- ❌ 再调 `resetStreamState`/`purgeStreamingItems` 触发时机（`turn_end`/`tool_start`/3s 宽限期）——在时序赌桌上挪座位。
- ❌ 引入第三条通道（新 thinking buffer / 新 live store / 新 rAF 队列）来「救」双通道——会变三通道互抢。
- ❌ 只调打字机速度/动画时长/折叠样式/`useSmoothStream` 的 `prevContentRef`——remount 的表象，根因在 key 不稳与双通道。
- ❌ 并行开权限/Chat-Work/idle 看门狗冲刺冲淡主线；整段升 `pi-coding-agent` AgentSession（有意延后）；用 Cursor Task/composer 顶替本机 kscc 改核。
- ❌ 在没砍双通道前加新测试锁行为——会把当前时序敏感的坏行为固化成契约。

---

## 证据索引（关键 file:line）

**TAgent-Desktop**
- `apps/electron/src/renderer/components/chat/Chat.tsx:208,210`（items / streamState 双 state）
- `apps/electron/src/renderer/components/chat/Chat.tsx:1145-1242`（落盘双 setState 抢帧）
- `apps/electron/src/renderer/components/chat/Chat.tsx:1316-1319,1329`（turn_end/tool_start resetStreamState + 3s 宽限）
- `apps/electron/src/renderer/components/chat/stream-item-model.ts:5,10-13,59-66,82-94,110-112`
- `apps/electron/src/renderer/components/chat/session-turn-model.ts:436-442,449-483,495-507,531-539,623-634`
- `apps/electron/src/renderer/components/chat/AssistantTurnView.tsx:72-84`
- `apps/electron/src/main/lib/ipc/session-service.ts:1272-1275`（STREAM_EVENT 单通道入口——主进程侧没问题，问题在 renderer 双写）
- `packages/shared/.../tagent-message.ts:123-131`（payload 契约：`sdk_message`/`stream_text_delta`/`stream_thinking_delta`/`result`/`tagent_event`）

**Proma（要抄的主契约）**
- `apps/electron/src/renderer/atoms/agent-atoms.ts:314`（liveMessagesMapAtom 单真源）
- `apps/electron/src/renderer/hooks/useGlobalAgentListeners.ts:768-796`（uuid 原地 upsert）
- `packages/shared/src/types/agent.ts:168-192,365`（thinking/text block 并列占位）

**DeepSeek-Reasonix（思考生命周期契约）**
- `desktop/frontend/src/lib/useController.ts:1196-1213`（kind 分流）、`:1476-1489`（turn_done 冻结、reasoning 写回）
- `desktop/frontend/src/lib/.../Message.tsx:897-907,965-972`（只折叠不删 + userOverridden）

**Kun（append-delta + status:completed）**
- `kun/src/domain/runtime-event-reducer.ts:171-174,455-483`（单 reducer append-delta）
- `kun/src/loop/model-round-engine.ts:113-130`（完成=completed，item 留存）

---

## 裁定

「肯定是骨架大问题」——成立。Desktop 错在 **delta 旁路 + 落盘双源**；稳的家都是 **一条消息原地长**。下一刀只做 **S1+S2（对齐 Proma partial upsert + 思考永驻）**，其它全部让路。
