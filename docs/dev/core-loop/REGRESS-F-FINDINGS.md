# REGRESS-F FINDINGS — 思考块仍有时立刻消失（E/D 残留）

> 日期：2026-08-07  
> 规格：`REGRESS-2026-08-07-RESIDUAL-SPEC.md` §F  
> 派工：`REGRESS-F-thinking-vanish-residual-brief.md`  
> 范围：只读摸底。未改源码、未 commit。

## 结论速览

- E 补丁（数据/streamState 层）**全部仍在**，未回退：思考不会在数据层被删光。
- D 补丁（concise `ThinkingFold` settle + body 常驻）**仍在**，但**只覆盖 concise 模式**。
- 残留根因：**full 模式**（默认模式）下的 `ProcessGroupView.ThinkingActivityRow` 从未进入 D/E 的 settle/retain 范围，思考正文在 `live→false` 瞬间 `body↔preview` 硬切，**立即卸 DOM 换成 4 行预览**——这就是用户说的「立刻消失」（非 settle 后折成「思考了 Ns」）。
- 是否需再修：**是**（最小修，对齐 D 在 concise 做的 settle + retain，移植到 full 的 `ThinkingActivityRow`）。

---

## 1. E/D 补丁逐文件核对（工作树现状）

| E/D 改动 | 文件:行 | 现状 |
|---|---|---|
| 无 `stop_reason` ⇒ `_partial:true`；透传 `stop_reason` | `packages/shared/src/utils/kscc-message-adapter.ts:98-105` | ✓ 在（`isPartial = m._partial === true \|\| stopReason == null`；`stop_reason` 透传 line 118） |
| 主进程 re-export shared | `apps/electron/src/main/lib/adapters/claude/kscc-message-adapter.ts:6` | ✓ 在 |
| 仅 content 有 thinking 才清 stream | `stream-item-model.ts:61-71` `shouldClearStreamThinking` | ✓ 在（不再凭 `stop_reason` 清） |
| `shouldClearStreamText` 对称 | `stream-item-model.ts:77-84` | ✓ 在 |
| upsert 保留已有 thinking 块 | `stream-item-model.ts:123-140` `preserveAssistantThinking` | ✓ 在；`applySdkMessageToItems` 内 4 处调用（222/261/274/284） |
| turn_end/result 先 commit 再清 | `stream-item-model.ts:143-170` `commitStreamThinkingToLastAssistant` | ✓ 在 |
| `Chat.tsx` `tool_start` 只清 text | `Chat.tsx:1285-1288` | ✓ 在（`setStreamState((prev) => (prev.text ? { ...prev, text: '' } : prev))`，注释 REGRESS-E/CL5） |
| `Chat.tsx` `turn_end` commit+reset | `Chat.tsx:1289-1302` | ✓ 在 |
| `Chat.tsx` `result` commit+reset | `Chat.tsx:1208-1221` | ✓ 在 |
| `resetStreamState` 全清调用点 | `Chat.tsx:1083-1087`（定义）；调用：`result`1214 / `turn_end`1295 / `sendQueued`1464 / 切会话 623,628 | ✓ 仅这 4+2 处，均为合法回合边界/新发/切会话，**无漏网全清** |
| D: concise `ThinkingFold` settle + body 常驻 | `ConciseTimelineView.tsx:206-324` | ✓ 在（`THINK_SETTLE_MS=1800`、settle timer 249-267、`__panel` grid 常驻 306-321） |
| D: `isLastSegment` 替换 `isLastOfKind` | `ConciseTimelineView.tsx:93,197-200` | ✓ 在 |
| D: `thinking-scroll-follow.ts` + vitest | `thinking-scroll-follow.ts` / `.vitest.test.ts` | ✓ 在 |
| D: CSS `.agent-concise-fold__panel` grid 0fr↔1fr | `chat.css:460-474,734` | ✓ 在 |

**未发现任何 E/D 函数回退或被删。** 数据层与 concise UI 层的「思考被删光」路径已堵死。

---

## 2. 落盘验证（`~/.tagent/agent-sessions/94cd158c-...jsonl`，最新会话）

抽样含 thinking 的回合（line 6–14），glm/kscc 双快照形态：

```
L6  assistant uuid=0b515e6c content=[thinking]      stop_reason=null   ← 思考（独立 uuid）
L7  assistant uuid=237b79b6 content=[text "让我先看看…"] stop_reason=null  ← 不同 uuid
L8  assistant uuid=193fddfb content=[tool_use Bash]  stop_reason=null  ← 不同 uuid
L9  user tool_result
L10 assistant uuid=71c3db3c content=[tool_use Read]  stop_reason=null
L12 assistant uuid=700c03e9 content=[thinking "现在我对项目…"] stop_reason=null  ← 第二段思考
L13 assistant uuid=2ddadf46 content=[text "了解了…"] stop_reason=null
L14 result (turn end)
```

要点：
1. **thinking 落盘 content 完整保留**（point 5 ✓）——数据层没剥。每段思考都是独立 assistant 消息、独立 uuid、`stop_reason:null`（= `_partial:true`）。
2. **每个快照 uuid 不同**：glm/kscc 不走「同 uuid partial→final upsert」，而是一块一消息一 uuid。因此 E 的 `preserveAssistantThinking`（仅在**同 uuid** upsert 时合并）**对本渠道几乎不触发**——思考之所以没丢，是因为它**作为独立 item 落盘**，而非被合并保留。
3. 数据层稳：思考以独立 `DisplayItem` 存在，`buildTurnPresentation` 经 `allBlocks`（`session-turn-model.ts:501-535`）收入 `process`，key=`think-${uuid}-${blockIndex}`，落盘后**稳定**。

---

## 3. 根因候选（带 path:line + 假设映射）

### 根因 1（主因，H3）：full 模式 `ThinkingActivityRow` 无 settle + body 硬卸

- `chat-display-prefs.ts:18` 默认 `chatProcessDisplayModeAtom = 'full'`。**用户默认走 full，不是 concise。**
- full 路径：`AssistantTurnView.tsx:307-316` → `ProcessGroupView` `displayMode="full"`；concise 分支（`AssistantTurnView.tsx:262-305`）**根本不渲染**。
- `ProcessGroupView.tsx:277-350` `ThinkingActivityRow`：
  - `open = userExpanded ?? (displayMode==='concise' ? false : isLive || !collapsible)`（line 301）。full：`open = isLive || !collapsible`。
  - `isLive = live && entry.key === lastThinkingKey`（line 228）。
  - `collapsible = shouldCollapseThinking(thinking)`：`text.length>200 || lines>4`（`process-group-model.ts:74-78`）。任何真实 CoT 都 >200 字 ⇒ `collapsible=true`。
  - 渲染：`{open ? <body> : <preview>}`（line 331-347）——**硬切，无 settle、无 CSS retain**。`__body` 与 `__preview` 是两块 DOM（`chat.css:1087,1095`），非 grid 0fr↔1fr。
- **触发「立刻消失」**：回合 `live→false` 瞬间（result/turn_end），最后一段正在流式的思考 `isLive` 翻 false ⇒ `open = false || !collapsible = false`（collapsible=true）⇒ **body 立即卸载，换成 4 行/200 字预览**。用户看到正在展开的思考正文瞬间消失，变成截断预览——**这正是「立刻消失，非 settle 后折成思考了 Ns」**。
- D 的 settle（`THINK_SETTLE_MS=1800`）+ body 常驻只在 `ConciseTimelineView.ThinkingFold`（concise）里；`ProcessGroupView.ThinkingActivityRow` 从未进 D 范围（D brief 明确「仅 `displayMode === 'concise'`」，D 改动文件清单不含 `ProcessGroupView.tsx`/`process-group-model.ts`）。
- **映射 H3**（`isLive` 瞬间 false + settle 被跳过路径卸 body）——但发生在 **full 的 `ThinkingActivityRow`**，而非 brief 假设的 concise `ThinkingFold`（后者 D 已修）。

### 根因 2（次要，H4 边界）：full 模式组级折叠叠在 settle 之前

- `ProcessGroupView.tsx:94-132` 组级 `planProcessGroupCollapse`：`live→false` 后 `SETTLE_MS=2500`（`process-group-model.ts:15`）静置 + 3s 倒计时 ⇒ `setExpanded(false)` ⇒ 整个 `__body` 卸载（`{showBody && <body>}` line 220）。
- 这一路有 2.5s+3s 缓冲，**不是**「立刻」；但与根因 1 叠加时，用户先看到根因 1 的 body→preview 瞬切，再看到整组收起，体感「思考整段没了」。
- concise 模式下组级 `!autoExpandWhenLive` 走 `collapse`（line 59），但 concise 不渲染 `ProcessGroupView` body，影响小。

### 根因 3（非 bug，产品区分，H4）：concise 把中段琐碎思考埋进 `work_stage.steps`

- `concise-timeline-model.ts:519-526`：中段思考若 `!isDeliverableThinking(t)` 且当前阶段已有 tool ⇒ 并入 `stageSteps`（`kind:'thinking'` step），**不升独立 `kind:'thinking'` segment**。`isDeliverableThinking`（`concise-timeline-model.ts:334-344`）要求 bold/标题/结论词或 len≥100+标点。
- 效果：短中段思考（"让我先看看…"<100 字或无结论词）在 concise 下只显示在 `WorkStageFold` 的步骤行里（`StageStepRow`，`ConciseTimelineView.tsx:502-577`），默认折叠，点开才见。用户若期待它像独立「思考了 Ns」折叠块，会误以为「块消失」。
- **这是产品行为（对齐 Cursor 阶段内思考），不是数据丢失**：思考仍在 `stage.steps`、仍在 DOM（展开阶段即可见）、落盘仍在。不需修。

---

## 4. 是否需再修

**是。** 根因 1 是真实 bug：默认 full 模式下思考正文在 `live→false` 瞬间被硬切卸载，无 settle、无 retain，与 D 在 concise 已实现的优雅折叠不一致。E 的数据层补丁救不了它（数据没丢，是 UI 卸 DOM）。

### 最小修建议（本轮不 apply）

对齐 D 在 `ConciseTimelineView.ThinkingFold` 的做法，移植到 `ProcessGroupView.ThinkingActivityRow`：

1. `apps/electron/src/renderer/components/chat/ProcessGroupView.tsx` `ThinkingActivityRow`：
   - 引入 `wasLive` ref + `settleTimer`（复用 `THINK_SETTLE_MS=1800`，从 `thinking-scroll-follow` 或新常量）。
   - `isLive` true→false 时不立即 `setOpen(false)`，先保持 `open=true` 1800ms 再折（与 concise 同节奏）；用户手动 toggle 时取消定时器。
   - 把 `{open ? <body> : <preview>}` 改为 body **常驻 DOM**：外层 `__panel` 用 CSS `grid-template-rows 0fr↔1fr` + `opacity` 过渡（复用 `.agent-concise-fold__panel` 同款），`__preview` 作为折叠态头栏摘要（或并入 head），不 null 卸载 body。
   - `open` 语义改为「展开 body」，折起后点开头栏仍见全文。
2. `apps/electron/src/renderer/styles/chat.css`：给 `.agent-thinking-row` 加 `__panel`/`__panel-inner`（grid 0fr/1fr + opacity，`prefers-reduced-motion` 下 `transition:none`），与 `.agent-concise-fold__panel` 对齐。
3. `process-group-model.ts`：`shouldCollapseThinking` 仍可用作「是否值得给折叠开关」，但不再决定 body 卸载。

**约束**：只动 full 的 `ThinkingActivityRow`；concise `ThinkingFold`（已修）零回归；`ProcessGroupView` 组级折叠状态机不动；不碰数据层/streamState。

### vitest 命令（修后跑，本轮不跑）

```
pnpm --filter @tagent/desktop vitest run apps/electron/src/renderer/components/chat/process-group-model.vitest.test.ts
pnpm --filter @tagent/desktop vitest run apps/electron/src/renderer/components/chat/stream-item-model.vitest.test.ts
pnpm --filter @tagent/desktop vitest run apps/electron/src/renderer/components/chat/regress-b-progress-live.vitest.test.ts
pnpm --filter @tagent/desktop vitest run apps/electron/src/renderer/components/chat/concise-timeline-model.vitest.test.ts
pnpm --filter @tagent/desktop vitest run apps/electron/src/renderer/components/chat/turn-presentation.vitest.test.ts
pnpm --filter @tagent/desktop vitest run apps/electron/src/renderer/components/chat/thinking-scroll-follow.vitest.test.ts
# + apps/electron typecheck
```

（若新增 `ThinkingActivityRow` settle 单测，补对应 `.vitest.test.ts`；纯 UI/DOM 行为可放 component test。）

---

## 5. 产品行为 vs bug 区分

| 现象 | 性质 | 出处 |
|---|---|---|
| concise 中段短思考埋进 `work_stage.steps`，不升独立折叠块 | **产品**（对齐 Cursor 阶段内思考） | `concise-timeline-model.ts:519-526` |
| concise `ThinkingFold` live→idle settle 1.8s 后折成「思考了 Ns」 | **产品**（D 已实现） | `ConciseTimelineView.tsx:249-267` |
| **full `ThinkingActivityRow` live→false 瞬间 body 卸载换 4 行预览** | **bug**（D 未覆盖 full） | `ProcessGroupView.tsx:301,331-347` + `chat.css:1087,1095` |
| full 组级 2.5s+3s 倒计时后整组收起 | **产品**（有缓冲，非立刻） | `ProcessGroupView.tsx:94-132` |

用户「立刻消失（非 settle 后折成思考了 Ns）」= 上表第 3 行 bug，不是第 2 行产品行为。

---

## 6. 关键文件清单

- `apps/electron/src/renderer/components/chat/ProcessGroupView.tsx:277-350`（`ThinkingActivityRow`，**bug 所在**）
- `apps/electron/src/renderer/components/chat/process-group-model.ts:15,74-78`（组级 settle 常量、`shouldCollapseThinking` 阈值）
- `apps/electron/src/renderer/styles/chat.css:1032-1102`（`.agent-thinking-row__body/__preview` 硬切）
- `apps/electron/src/renderer/atoms/chat-display-prefs.ts:18`（默认 `full`）
- `apps/electron/src/renderer/components/chat/ConciseTimelineView.tsx:206-324`（concise 已修的 `ThinkingFold`，作移植模板）
- `apps/electron/src/renderer/components/chat/Chat.tsx:1083-1302`（E 数据层补丁，确认 intact）
- `apps/electron/src/renderer/components/chat/stream-item-model.ts:61-170`（E 数据层补丁，确认 intact）
- `packages/shared/src/utils/kscc-message-adapter.ts:98-105`（E `_partial` 推断，确认 intact）
- `~/.tagent/agent-sessions/94cd158c-...jsonl`（落盘实证：每块一 uuid、思考保留、全 `stop_reason:null`）

---

## 补充（独立只读摸底，2026-08-07，未改原章节）

> 本节由另一轮只读摸底追加，**不改动上文**。上文「根因 1（full 模式 `ThinkingActivityRow` 硬卸）」经独立核对**成立且为主因**：`chat-display-prefs.ts:18` 默认 `'full'` 已确认；`ProcessGroupView.tsx:331-347` 确为 `{open ? __body : __preview}` 硬切、无 settle；`open = userExpanded ?? (displayMode==='concise' ? false : isLive || !collapsible)`（`:301`），full 下 `live→false` 且 `collapsible=true`（CoT>200 字 / >4 行，`process-group-model.ts:74-78`）即 `open=false` → body 卸 DOM 换预览。D 的 settle/retain 仅覆盖 concise `ThinkingFold`（`ConciseTimelineView.tsx:206-324`），**从未进 full 的 `ThinkingActivityRow`**。结论：**主因 = 上文根因 1，优先按上文 §4 最小修（把 D 的 settle+body 常驻移植到 `ThinkingActivityRow`）**。

### 次因 RC1（concise / 数据层，与主因不同模式，互补不冲突）

即便切到 concise（或修好 full 后用户切 concise），仍有一处 E 补丁缺口会致**末段思考 delta 丢失**：

- `stream_thinking_delta` 按 rAF 合帧缓冲：`Chat.tsx:1262-1272` 累积进 `pendingThinkingRef`，`requestAnimationFrame(flushThinkingDelta)`；rAF 回调 `Chat.tsx:1094-1100` 才写进 `streamState`。
- `sdk_message` 分支**有守卫**：`Chat.tsx:1183-1189` 先 `cancelAnimationFrame` + 取 `pendingThinkingRef` + 清 ref，再把 pending 并入 `streamState`。
- `turn_end`（`Chat.tsx:1289-1295`）与 `result`（`Chat.tsx:1208-1214`）**没有这个守卫**：直接读 `streamStateRef.current.thinking`（rAF 未 flush ⇒ 不含本帧 batch），`commitStreamThinkingToLastAssistant` 后 `resetStreamState()`（`Chat.tsx:1083-1087`，会 `pendingThinkingRef.current=''`）把**未 flush 的 batch 丢弃**；后续 rAF fire 时 ref 已空，no-op。
- ⇒ 与 turn_end/result 同帧到达、尚未 rAF flush 的思考增量被永久丢弃。落盘 items 无该段 thinking ⇒ concise `buildConciseTimeline` 0 条 `thinking` 段 ⇒ `ThinkingFold` 整块消失。
- 与 E「一字对齐缺口」：E 给 turn_end/result 加了 `commitStreamThinkingToLastAssistant`，却漏抄 `sdk_message` 的 rAF flush。
- 触发面：**仅 concise 模式 + 思考只走 delta（无 content 快照）的渠道**才致整块消失；GLM（思考写进 content 快照，本机 jsonl 53 条带 thinking 块、`stop_reason:null`）主体靠 `preserveAssistantThinking` 保住，RC1 只危及其末段增量。故**次于主因**。

### RC1 最小修建议（仅 concise 残留，本轮不 apply、不 commit）

`Chat.tsx` `turn_end` 与 `result` 提交前复制 `sdk_message` 的 rAF flush，把 `pendingThinkingRef` 并入提交值：

```ts
// 提交前先 flush rAF 合帧缓冲，否则同帧增量被 resetStreamState 丢弃（REGRESS-F RC1）
if (thinkingFlushRafRef.current != null) {
  cancelAnimationFrame(thinkingFlushRafRef.current)
  thinkingFlushRafRef.current = null
}
const pendingDelta = pendingThinkingRef.current
pendingThinkingRef.current = ''
pendingThinkingUuidRef.current = undefined
const buffered = (streamStateRef.current.thinking + pendingDelta).trim()
if (buffered) setItems((prev) => commitStreamThinkingToLastAssistant(prev, buffered))
resetStreamState()
```

（`turn_end` `Chat.tsx:1289-1295`、`result` `Chat.tsx:1208-1214` 各加同款 flush；其后 purge / scheduleRunStop 不变。）

### 次因 RC2（更边缘，可不修）

`commitStreamThinkingToLastAssistant` 末条 assistant「已有 thinking」即 skip（`stream-item-model.ts:156-158`），晚于最后一条含思考快照的 streamState 增量无处落盘 → reset 丢失。建议 RC1 修完实机复测，仍有「尾部思考丢」再上 RC2（改追加/续写并防重复）。

### 测试（RC1 修后跑）

```bash
bunx vitest run \
  apps/electron/src/renderer/components/chat/stream-item-model.vitest.test.ts \
  apps/electron/src/renderer/components/chat/regress-b-progress-live.vitest.test.ts \
  apps/electron/src/renderer/components/chat/concise-timeline-model.vitest.test.ts
# + apps/electron typecheck；+ 上文 §4 的 full `ThinkingActivityRow` settle 单测
```

### 优先级裁定建议

1. **先按上文 §4 修 full `ThinkingActivityRow`**（主因，匹配默认模式 = 用户实际所见）。
2. **再实机复测 concise**：若 concise 仍有末段思考丢，上 RC1；RC2 最后。
3. **同时先排除**「测试设备跑 pre-`369d6f7` 旧包」（交接明写 E 实机未验完，「换设备」反馈可能仅是没装新包）。
