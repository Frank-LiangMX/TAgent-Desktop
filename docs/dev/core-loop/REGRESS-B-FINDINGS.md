# REGRESS-B 调查结论 — Cursor 式「思考后阶段性总结」live 不显示、结束才出现

> 日期：2026-08-07  
> 规格：`docs/dev/core-loop/REGRESS-2026-08-07-SPEC.md` §B  
> 对照：`CURSOR-CONCISE.md`、`investigation/kscc-stream-flush/hypotheses.tsv`  
> 范围：仅 `displayMode === 'concise'`；`full` 零回归。

---

## 0. 结论先行

**kscc 是「双源流式」，Pi 是「单源流式」。未提交的 `_partial` 修复让 partial 不再被当终态灌进 process（治住了 H08 的「闪一下被 final 替换」），但没治本症状——段间 progress 在 live 期间不是「持续可见」，而是每帧拼成 `partial文本\n\n新delta碎片` 抽搐，直到 final 才稳。**

最小渲染侧修复（不改主进程 IR、不强迫 kscc 必发/不发 delta，符合 `CURSOR-CONCISE.md` §4）：在 concise+live 里，把 `streamState.text`（自上次 partial 以来累积的新 delta）**拼接到当前 partial 文本块尾部**，使「partial 文本 + 增量」成为**单一 narrative 源**，逐字打字机增长——与 Pi 单源语义对齐。

---

## 1. 回答 brief 的四个问题（带行号）

### Q1 live 时工具间 text / stream_text_delta 是否到达渲染层？卡在哪？

都到达了，**没有卡在 adapter 或落盘过滤**：

- `stream_text_delta`：`kscc-message-adapter.ts:130-140` 转成 `TAgentControlEvent{kind:'stream_text_delta'}` → `Chat.tsx:1253-1256` `setStreamState((prev) => applyTextDelta(prev, p.text))` 累积进会话级 `streamState.text`。
- 段间 text（partial assistant 的 text 块）：`kscc-message-adapter.ts:85-113` 透传 `_partial` → `Chat.tsx:1197-1199` `applySdkMessageToItems` 按 uuid 原地 upsert → `buildTurnPresentation` 主循环 `session-turn-model.ts:506-535` 把 content[] 的 text 块推入 `process`。

**所以问题不在「到达不到」，而在「到达后两条源被拼成两个独立 process text 条目」。**

### Q2 buildTurnPresentation + buildConciseTimeline：live 时 progress narrative 是否被算出？是否渲染？

- **算出了**。`concise-timeline-model.ts:544-553`：text 类型 → `tone = i < lastToolIdx || isLive ? 'progress' : 'final'`。live 时工具间 text 一律 `progress`。`pushNarrative`（`concise-timeline-model.ts:415-434`）把它推成 `narrative` 段。
- **也渲染了**。`ConciseTimelineView.tsx:98-106`：`NarrativeRow` 渲染每个 narrative，`isStreaming={isLive && seg.key === lastNarrativeKey}`，progress tone 走 `NarrativeSmoothBody` 打字机（`ConciseTimelineView.tsx:461-521`）。

**所以 narrative 在 live 时确实算出且渲染——但内容是错的（见 Q3）。**

### Q3 未提交的 `_partial` 修复是否足以让 progress 持续可见？缺口在哪一帧？

**不足以。未提交修复治了 H08（progress 卡片闪一下被 final 同 uuid 替换），但留了另一个缺口：段内 partial 文本 + delta 碎片「双条目抽搐」。**

未提交修复做了三件事（验收通过）：
1. `kscc-message-adapter.ts:93,110` 透传 `_partial`（H01/H05）✅
2. `session-service.ts:1239-1259` partial 不落盘（H01/H05）✅
3. `session-turn-model.ts:544-561` `isFinalAssistant` 守卫：partial 不触发「单真源切流式 = 抽空 streamingText」（H08）✅ —— 这条让 partial 文本**继续留在 process**，progress 卡片不再被 final 替换闪现。

**缺口在 `session-turn-model.ts:666-700` 的 `holdStreamInProcess`（concise 分支）**：

- concise+live 时 `holdStreamInProcess = Boolean(isActive && streamText)`（`:675-676`）。
- partial 文本块「正在」已被主循环推成一条 process text（`:606-609`）。
- `streamState.text` = 自上次 partial 以来的新 delta（如「摸清」）——因为 `stream-item-model.ts:74-81 shouldClearStreamText` 在 partial 带 text 时清空 streamState，所以 streamState 永远只装「上次 partial 之后的新增量」。
- `holdStreamInProcess` 把这个 delta 当**新条目**推入 process（`:694-695` `process.push({ type:'text', key:'stream-text', text: streamText })`），因为 `streamText.startsWith(last.text)` 与反向都不成立（「摸清」与「正在」非前缀）。
- → process 里有两条 text：`「正在」` + `「摸清」`。
- `buildConciseTimeline` 的 `pushNarrative`（`concise-timeline-model.ts:423-432`）看到两条非前缀 progress text → `last.text = ${last.text}\n\n${trimmed}` **拼成 `「正在\n\n摸清」`**。

**用户观感**：段间 progress 不是干净的逐字「正在→正在摸清→正在摸清目录」，而是每帧 `正在\n\n摸清` → `正在摸清\n\n目录` 抽搐，直到 final 同 uuid 落盘把 content[] 文本对齐才稳——**这就是「live 抽搐、结束才正常」的真症状**。

模拟证据（`REGRESS-B-sim.test.ts` 真实 reducer 还原每帧）节选：

```
delta "摸清"   stream.text="摸清"  processTexts=["正在","摸清"]    narratives=正在\n\n摸清[progress]
partial "正在摸清"                    processTexts=["正在摸清"]     narratives=正在摸清[progress]   ← partial 对齐后短暂正常
delta "目录"   stream.text="目录"  processTexts=["正在摸清","目录"] narratives=正在摸清\n\n目录[progress]  ← 又抽
```

### Q4 kscc 是否根本不发「段间 text」的 partial/delta，只在 final 一次给全文？

**否。kscc 两样都发**（`claude-agent-adapter.ts:162` `includePartialMessages: true`）：

- 持续发 `stream_event`/`stream_text_delta`（每 token）。
- 周期发 partial assistant（`_partial:true`，content[] 累积）。
- 段尾发 final assistant（同 uuid、`stop_reason`、`_partial` 无）。

**对比 Pi（单源）**：`pi-agent-adapter.ts:488-585`、`pi-agent-adapter.event-ir.test.ts:109-141` —— Pi 的 `message_update.text_delta` **不再产 `stream_text_delta`**，注释明确「单真源走 partial content[]」。Pi 只有 partial content[] 一条源，渲染层永远不会出现「partial 文本」与「delta 碎片」两条目相冲。

**所以 kscc 的双源是结构性的**：渲染侧必须把两源**归一**——这正是 `CURSOR-CONCISE.md` §3 验收 6「渲染侧兜底」要的：即使整段一次落盘也走打字机，且双源时不抽搐。

---

## 2. 根因定位（与 hypotheses.tsv 对齐）

| 现象 | 对应假设 | 状态 |
|------|----------|------|
| partial 被当终态灌进 process → final 替换闪现 | H01/H08 | 已被未提交 `_partial` 修复治住 |
| 落盘帧把 useSmoothStream 推到 reset「一大团」 | H02/H06 | 已被 useSmoothStream 子串兜底治住 |
| 段内 partial 文本 + delta 碎片双条目 → `\n\n` 抽搐 | **本调查新证（H08 同根延伸）** | **本次最小修复治本** |

H08 行 `partial 不带 _partial 时 streamingText 切空，partial text 走 message content 路径先进 process` —— 未提交修复让 partial 带 `_partial` 后，streamingText **不**切空，partial text 仍在 process；但 `holdStreamInProcess` 又把 delta 当新条目加进来 → 两条目。**H08 修复把「闪」换成「抽搐」，本修复把「抽搐」收成「逐字」。**

---

## 3. 修复目标映射

| brief 修复目标 | 本次如何达成 |
|----------------|--------------|
| 1. live 期间已到达段间 text 以 `narrative.progress` 持续可见（打字机 OK） | concise+live 把 `streamState.text`（自上次 partial 后的增量）拼到当前 partial 文本块尾部 → 单源 narrative 逐字增长 |
| 2. turn 结束后尾部升 final；历史打开不重播 | 已由 `concise-timeline-model.ts:550-551` `i<lastToolIdx \|\| isLive ? progress : final` + `ConciseTimelineView.tsx:536-538` 非直播 instant 全文保证；本次不动 |
| 3. 补 vitest：`thinking → text(progress) → tool → text(progress) → …` 在 `isLive=true` 时 segments 含 progress | `REGRESS-B-sim.test.ts` 固化为回归断言 |
| 4. 不改 permission/Chat-Work | 仅改 `session-turn-model.ts` 的 concise `holdStreamInProcess` 分支；full 模式零改动 |

---

## 4. 不做

- 不改主进程 IR / 不改 `claude-agent-adapter.ts`（不强迫 kscc 单源，渲染侧兜底）。
- 不改 `useSmoothStream.ts`（已被子串兜底覆盖；本次缺口不在打字机层）。
- 不编造无 text 时的假进度文案。
- 不 commit / push、不改 permission / Chat-Work。
