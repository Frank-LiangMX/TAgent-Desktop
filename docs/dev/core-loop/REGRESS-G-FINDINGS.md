# REGRESS-G 调查结论 — 思考段间无阶段性总结（live/落盘）

> 日期：2026-08-07  
> 规格：`docs/dev/core-loop/REGRESS-2026-08-07-RESIDUAL-SPEC.md` §G  
> 派工：`docs/dev/core-loop/REGRESS-G-stage-summary-persist-brief.md`  
> 对照：`REGRESS-B-FINDINGS.md`、`CURSOR-CONCISE.md`、`HANDOFF-2026-08-07.md`  
> 范围：仅 `displayMode === 'concise'`；本轮**只读摸底**，不改代码、不 commit。

---

## 0. 结论先行（修正前稿）

> **注意**：本目录已存在一份 `REGRESS-G-FINDINGS.md`（前轮/并行稿），定性为「模型不吐」，并断言「落盘不丢 text」（其 §1.Q2 末、§1.Q3、§5）。本轮用**真实落盘会话数据 + 还原实验**复核，发现该定性**过绝对**、其「落盘不丢 text」断言**不成立**。G 实为**两因并存**，且其中一条是 369d6f7 当晚引入的结构性落盘丢失。下文带证据修正。

**G 是「吐了但落盘丢」+「prompt 抑制吐量」两因并存，不是单一「模型不吐」。**

1. **真实会话证明模型会吐段间 text**：采样 4 个 `~/.tagent/agent-sessions/*.jsonl`，assistant 文本块大量存在且**紧跟思考**——`thinking → text(段间短文) → tool_use` 是常态，非罕见（§2.1）。前稿「模型被 prompt 按住完全不吐」与实测不符。
2. **落盘确实丢 text（前稿断言错误）**：kscc 把段间短文作为**独立 assistant 消息**发，且 `stop_reason: null`（实测 483/483 assistant 消息 `stop_reason` 皆 null，§2.2）。369d6f7 新增的 `_partial` 推断规则 `stop_reason == null ⇒ _partial:true`（`kscc-message-adapter.ts:105`）把这些**文本消息**也标成 partial，被落盘闸口 `session-service.ts:1246` 跳过 → **不进 panel JSONL** → 重开历史轮，段间短文消失。还原实验证实（§2.3）。
3. **prompt 抑制是另一因（前稿对，但不是全部）**：`output-style-prompt.ts:14,17` 禁止「逐步旁白工具过程」，确把**长篇**段间旁白压成**短句或无**（实测 2–29% 思考段后无 text，§2.1）。但它压不住全部——71–100% 的思考段后仍有短 text。

**与 B 的关系**：B 的渲染补丁全在且正确（§1.Q1 已逐条核对当前行号），但它只修「吐了之后 live 双源抽搐」，**未覆盖「段间 text 作为独立 stop_reason:null 消息被落盘闸口丢」**——这条是 369d6f7 为治 E 引入 `_partial` 推断时对「独立文本快照」的误伤。B 的历史轮单测（`regress-b-progress-live.vitest.test.ts:198-257`）用**合成**的 `stop_reason:'tool_use'` 且 text+tool 同消息形状，**没复现真实「独立 text 消息、stop_reason:null」形状**，故未暴露本缺口。

---

## 1. 回答 brief 必答（带 path:line）

### Q1 B 补丁关键路径是否仍在？

**全在**（工作树即 `369d6f7` 合并后状态，逐行核对当前行号）：

| B 关键路径 | 现位 | 状态 |
|------------|------|------|
| `_partial` 推断 + 透传 stop_reason | `packages/shared/src/utils/kscc-message-adapter.ts:102-119`（`isPartial = m._partial===true \|\| stopReason==null`，`:105`） | ✅ 在（**但本规则即 G 落盘丢失的源头，见 §2.2**） |
| partial 不落盘闸口 | `apps/electron/src/main/lib/ipc/session-service.ts:1242-1257`（`isPartial` 判定 `:1243-1244`，`if(!isPartial)` 才 `appendPanelMessages`/`appendSdkMessages` `:1246-1257`） | ✅ 在 |
| `isFinalAssistant` 守卫 | `session-turn-model.ts:544-545` | ✅ 在 |
| concise `holdStreamInProcess` 双源归一 | `session-turn-model.ts:691-760`（`lastStreamingPartialText` `:701-716`、拼接 `:753`） | ✅ 在 |
| concise 跨段保护 | `session-turn-model.ts:554-586`（`streamSameSegmentAsFinal`） | ✅ 在 |
| `buildConciseTimeline` progress 条件 `i<lastToolIdx \|\| isLive` | `concise-timeline-model.ts:561-562` | ✅ 在 |
| `useSmoothStream` 子串兜底 | `packages/ui/src/hooks/useSmoothStream.ts:185-202` | ✅ 在 |

接线（`AssistantTurnView` 喂 `isLiveTurn`/`streamState`/`displayMode`/`answerTexts`/`streamingText`/`isLive`）亦无丢参。

### Q2 「阶段性总结」在 IR/落盘里对应什么？

- **真身 = 主线 assistant `message.content[]` 里的 `text` 块**（`kscc-message-adapter.ts:94-96` 透传）→ `applySdkMessageToItems`（`stream-item-model.ts:183-293`）按 uuid upsert → `buildTurnPresentation` 收进 `allBlocks`（`session-turn-model.ts:529-530`）→ concise `splitAnswer=false`（`:605-609`）永不外置 → 推入 `process`（`:631-633`）→ `buildConciseTimeline` 投成 `narrative`（`concise-timeline-model.ts:555-564`）。
- **不是**单独一条「总结 message」，**不是** UI 凭空合成句子。产品层合成的只有两类**非句子**摘要：`work_stage.summary`「探索了 N 个文件」（`concise-timeline-model.ts:164-199`）与 `ThinkingFold` 头「思考了 Ns」（`session-turn-model.ts:850-861`）。
- **落盘形状（关键）**：实测 kscc 把段间短文发成**独立 assistant 消息**（`content=[text]`，无 tool_use），且 `stop_reason: null`（§2.2）。落盘闸口以「IR `_partial`」为准（`session-service.ts:1243-1244`），`stop_reason:null` → `_partial:true` → **跳过 `appendPanelMessages`**（`:1246`）→ 该 text 消息**不落盘**。live 仍可见（`sendPayload` 在 `:1258` 无条件推，不受 `isPartial` 影响），但重开历史轮即丢。

### Q3 思考 → text(progress) → tool 合并后，text 是否被憋/覆盖/误分类？

**前提：text 已到达渲染层（live 期间成立）。** 逐条：

- **(a) 憋到 turn_end？否（live）。** partial assistant 一到即 upsert（`Chat.tsx:1198-1200`），text 块立即进 `allBlocks`/`process`；`streamState.text` delta 经 `holdStreamInProcess` 即时进 process（`session-turn-model.ts:725-760`）。**但落盘侧相反**：text 消息因 `_partial:true` 根本不进 panel（§2.3），重开轮才「憋没」——这是 G 的主症状来源。
- **(b) 被同 uuid final 覆盖丢中间 text？否。** 同 uuid partial→final 累积 content；跨段不同 uuid 各自独立。`preserveAssistantThinking`（`stream-item-model.ts:123-140`）只补思考。**但**：真实形状里段间 text 是**独立 uuid**（与后续 tool_use 不同 uuid），其上没有「同 uuid final」来承接落盘——它要么自己落盘（需 `stop_reason` 非空），要么被闸口丢。实测是后者。
- **(c) tone 错？否。** `i<lastToolIdx \|\| isLive ? 'progress':'final'`（`concise-timeline-model.ts:561-562`）：段间短文恒在工具前 → 恒 progress，`NarrativeRow` 渲染（`ConciseTimelineView.tsx:115-122`）。还原实验确认历史轮 `narr[progress]` 正确产出（§2.3 场景「真实形状经 concise 历史」）。

**结论**：渲染/分类三条失败模式都不成立；**落盘闸口**这条前稿未查的路径才是丢 text 的真凶。

### Q4 kscc 是否根本不发段间 text？产品层有无合成？差在哪？

- **会发，且大量发。** 实测 4 个会话：text-only assistant 消息 3–180 条/会话；`thinking → text` 邻接占 71–100%（仅 1 个会话 71%，其余 ≥97%；§2.1）。`includePartialMessages:true`（`claude-agent-adapter.ts:162`）发 partial 含 text 块，`stream_event.text_delta` 转 `stream_text_delta`（`kscc-message-adapter.ts:139-148`）由 `Chat.tsx` 累积进 `streamState.text`。
- **prompt 抑制的是「长旁白」，不是「短 text」**：`output-style-prompt.ts:14,17,18`（经 `session-service.ts:1067` 注入 systemPrompt）禁「逐步旁白工具过程」「工具过程几乎不提」。模型遵循 → 多数段间 text 是**一句短文**（实测：「先探查一下目录规模。」「摸清了，开始编辑。」），少数思考段后无 text（2–29%）。
- **产品层不合成句子**（正确，受 `CURSOR-CONCISE.md §4`「无 text 时不编造」约束）：`narrative.text` 只来自模型 text 块 / streamState delta。
- **差在哪**：用户期望「思考后落盘一句总结」（`CURSOR-CONCISE.md §1`「进度短文（深色内联）」、§3.4「工具间 text = 进度短总结」）。模型吐了短 text，**live 也可见**，但**落盘被 `_partial` 推断误杀** → 重开不见 → 观感「没落盘/不可见」。

### Q5 对照 `CURSOR-CONCISE.md` 验收，G 是「模型不吐」还是「吐了但 UI/落盘丢」？

**吐了但落盘丢（主）+ prompt 抑制吐量（次）。**

- **§3.4「工具间 text = 进度短总结；尾部 = 最终正文」**：模型吐了工具间 text，但落盘丢失 → **违反**「落盘后中间 progress 仍在 timeline」（§SPEC G 期望「回合结束后中间 progress 仍在 timeline（不丢）」）。
- **§3.6「kscc one-shot final：即使无 `stream_text_delta`、整段 `sdk_message` 一次落盘，concise 尾部正文仍走打字机」**：讲的是**尾部 final**，与段间 progress 无关；它兜底尾部，兜不出段间短文。
- **§4「无 text 时不编造进度文案」**：本条不冲突——这里有 text，是落盘丢的，不是无 text 要编造。
- **§3.4 + §4 联读**：当 prompt 把某段 text 压成无（2–29% 段），产品层不补 → 那几段确实无短文（前稿说的现象，但只是 G 的一部分）。

---

## 2. 证据

### 2.1 真实会话：模型会吐段间 text，且紧跟思考

采样 `C:/Users/liangmingxuan/.tagent/agent-sessions/`（最新 4 个多段会话）：

| 会话（前 8 位） | assistant | text-only 消息 | thinking→tool（无 text） | thinking→text（有段间短文） | 段后无 text 占比 |
|---|---|---|---|---|---|
| 6cc114a0 | 536 | 180 | 1 | 52 | 2% |
| 94cd158c | 33 | 12 | 0 | 10 | 0% |
| bd473c93 | 9 | 3 | 0 | 3 | 0% |
| db3245b5 | 77 | 15 | 5 | 12 | 29% |

段间短文实测样本（6cc114a0）："先探查一下这个目录的规模和顶层结构，再决定怎么分析。" / "路径不存在，先看看实际目录结构。" / "摸清全貌了。这是剑网3客户端场景资源…" / "命名规范已基本清晰。发现几个关键点…再补几个关键采样确认：Texture…"。

→ **模型广泛吐段间短文，仅少数段（0–29%）被 prompt 压成无 text。** 前稿「模型被 prompt 按住不发」与实测不符。

### 2.2 真实会话：assistant 消息 `stop_reason` 全为 null

同上 4 会话，**逐条** `o.message.stop_reason`：

- 6cc114a0：536 assistant，`stop_reason` 有值 **0**，null/缺 **536**，`_partial` 顶层标记 **0**。
- 94cd158c / bd473c93 / db3245b5：同上，`stop_reason` 有值 **0**。

raw JSON 样本（6cc114a0，text-only 消息）：`{"type":"assistant","message":{"id":"…","type":"message","role":"assistant","content":[{"type":"text","text":"你好！我是 TAgent…"}],"model":"glm-5.2","stop_reason":null,"stop_sequence":null,...}}`。

→ **kscc（glm-5.2 渠道）对 assistant 消息一律发 `stop_reason: null`**，无论该消息是 text / thinking / tool_use。按 369d6f7 新增规则 `isPartial = m._partial===true || stopReason==null`（`kscc-message-adapter.ts:105`），**全部 assistant 消息被推断为 `_partial:true`**。

> ⚠ 不确定点：上述数据为 2026-07-24（早于 369d6f7）。**当前** kscc/SDK 是否在「final tool_use / end_turn」消息上设 `stop_reason`（如 B 单测假设的 `'tool_use'`/`'end_turn'`）无法从本机现存会话确证（最新会话文件即 07-24，今日实机会话未落盘到此处）。此点决定 §2.3 场景 A/B 哪个为真，须实机抓一轮新会话 JSONL 复核（见 §4 验证项）。

### 2.3 还原实验：落盘闸口对真实形状的丢弃

复刻 `session-service.handleSdkStreamMessage` 落盘判定（`session-service.ts:1241-1257`），喂两种真实形状（text 与 tool_use 在**独立消息**）：

**场景 A**（假设当前 kscc 在 final tool_use/end_turn 上设 `stop_reason`，B 单测形状）：

```
u0 thinking              _partial=true  -> skipped
u1 text "先探查目录。"    _partial=true  -> SKIPPED ← 段间短文丢
u2 tool_use (stop:tool_use) _partial=undef -> persisted
u3 text "完成。" (stop:end_turn) _partial=undef -> persisted
PERSISTED texts: ["完成。"]   ← 段间 "先探查目录。" 丢失
```

**场景 B**（实测形状：全部 `stop_reason:null`）：

```
u0 thinking   _partial=true -> skipped
u1 text       _partial=true -> skipped
u2 tool_use   _partial=true -> skipped
u3 text       _partial=true -> skipped
PERSISTED texts: []   ← 整轮 text 全丢
```

**关键**：无论 A/B，**段间 text-only 消息（`stop_reason:null`）一律被落盘闸口丢**。区别只是场景 A 靠「final tool_use 消息自带 text」救回（若 kscc 真把 text 并进 tool_use final）；场景 B 全丢。**前稿断言「落盘不丢 text」依赖「final 同消息带 text」，但实测真实形状是 text 与 tool_use 分离**——故该断言不成立。

另还原「真实形状经 concise 历史管线」（先 `sdkMessageToIR` 再 `buildTurnPresentation`+`buildConciseTimeline`，`isLive=false`）：当 text 消息**已在 items 里**（即未被落盘闸口丢、或 live 期间）时，段间短文正确产出 `narr[progress]`（"先探查一下目录规模。" / "摸清了，开始编辑。"），尾部 `narr[final]`（"完成。已修改 a.ts。"）。→ **渲染/分类无错，丢只发生在落盘闸口**。

live 还原（`thinking → delta → partial(text) → final(tool)` 逐帧）：每帧 `narr[progress]` 都可见、逐字增长、无 `\n\n` 抽搐，final 后稳定。→ **B 的 live 补丁对「吐了的 text」确实有效**。

---

## 3. 与 REGRESS-B 的关系

- **B 修对了渲染/抽搐侧，但未覆盖「独立 text 消息被落盘闸口丢」**。B 的历史轮单测（`regress-b-progress-live.vitest.test.ts:198-257`）合成的是 `stop_reason:'tool_use'` 且 text+tool_use**同消息**形状，未复现真实「独立 text 消息、`stop_reason:null`」形状，故未暴露本缺口。B live 单测（`:101-196`）同理用合成 delta。
- **B 的补丁仍在且正确**（§1.Q1），治「吐了之后 live 双源抽搐」。G 暴露的是 B 未触及的**落盘闸口**与**上游 prompt 抑制**两条。
- **G 不是 B 的回归**，但 G 的落盘丢失是 369d6f7 为治 E 引入 `_partial` 推断（`kscc-message-adapter.ts:105`）对「独立文本快照」的**附带误伤**——E 要「partial 不落盘防 partial 堆积」，但 partial 判定扩到「所有 `stop_reason:null`」后，把 kscc 本就 `stop_reason:null` 的独立段间 text 也卷进去了。
- 与 F 的交叉点仅在 timeline 渲染；G 的修在落盘闸口/上游 prompt，不动 timeline，不与 F 互踩。

---

## 4. 最小修建议（不本轮实施）

**先做 1 项实机验证**，再在两个根因里选修：

### 验证项（必做，决定 A/B 选哪个修）

实机跑一轮 concise 多段会话，抓**新**会话的 panel JSONL（`~/.tagent/agent-sessions/<id>.jsonl`），看：
1. final tool_use / end_turn 消息是否带 `stop_reason`（非 null）？
2. 段间 text 是与 tool_use **同消息**还是**独立消息**？

→ 若（1）`stop_reason` 仍全 null 且（2）独立 → §2.3 场景 B，落盘全丢，修必须做。
→ 若（1）final 带 `stop_reason` 且（2）text 并进 final → 落盘不丢，G 仅剩 prompt 抑制，转方案 A。

### 方案 1（修落盘闸口·若场景 A/B 确认落盘丢）—— 最小代码修

**根因**：`_partial` 推断把「无 stop_reason 的独立 text 消息」也判为 partial → 落盘跳过。

**最小修**：在 `session-service.ts:1243-1244` 的 `isPartial` 判定里，对「content 含非空 text 块且无 stop_reason」的 assistant 消息**不下跳过**（它不是被同 uuid final 替换的中间快照，而是独立交付段）。即落盘闸口放行 `content` 含 text 的消息，仍跳过纯 thinking/纯 tool_use 的 partial 快照。

- 改动点：`apps/electron/src/main/lib/ipc/session-service.ts:1243-1244` 一处判定。
- 风险：需确认不破坏 E「partial 不落盘防堆积」（E 针对的是同 uuid partial→final 替换链；含 text 的独立消息无后续同 uuid final，不会被替换，放行不增堆积）。
- 测试：复现 §2.3 场景 A/B 为单测（`regress-g-persist-text.vitest.test.ts`），断言「含 text 的 stop_reason:null 消息进 panel，纯 thinking/纯 tool_use partial 仍跳过」。
- 命令：`bunx vitest run apps/electron/src/main/lib/ipc/session-service.ts` 相关测 + 新测。

### 方案 2（松绑 prompt·若验证显示落盘不丢、仅吐量少）—— 改产品文案

`output-style-prompt.ts:14,17` 加窄口：允许「思考后写**一句**进度短文」，仍禁「逐步旁白每步工具 / 结尾复盘长清单」。需同步松 `execution-mode-prompt.ts` 的 Chat/Work 短答约束，并实机验模型守得住「一句」边界。**仅改 prompt 文案，不动 .ts 渲染**。

### 方案 3（不推荐·产品层合成句子）

违反 `CURSOR-CONCISE.md §4`「无 text 时不编造进度文案」，否决。

### 建议落位

落盘丢失是**确定性结构 bug**（只要 kscc 发独立 text 消息且 stop_reason:null 就丢），应优先按方案 1 修（最小、可单测固化）；prompt 松绑（方案 2）视用户对「一句短文」的偏好再定，可与方案 1 并行。

---

## 5. 不做（本轮）

- 不改任何 .ts/.tsx（本轮只读摸底）。
- 不 commit / push；不动 permission / Chat-Work。
- 不在产品层编造假进度短文（违 `CURSOR-CONCISE.md §4`）。
- 不擅自覆盖前轮 `REGRESS-G-FINDINGS.md` 的结论——本稿以实测证据修正其「落盘不丢 text」断言与「模型不吐」定性，供总监裁定。两稿分歧点集中在「落盘是否丢 text」：前稿依赖「final 同消息带 text」假设，本稿以实测「text 与 tool_use 分离 + stop_reason:null」证伪该假设。

---

## 6. 关键文件

- `packages/shared/src/utils/kscc-message-adapter.ts:102-119`（`_partial` 推断，G 落盘丢源头）
- `apps/electron/src/main/lib/ipc/session-service.ts:1238-1277`（落盘闸口 `:1243-1257`，`sendPayload` 无条件推 `:1258`）
- `apps/electron/src/renderer/components/chat/Chat.tsx:672-689`（历史加载 `readPanelMessages` → `sdkMessageToIR` → items）
- `apps/electron/src/renderer/components/chat/session-turn-model.ts:431-811`（concise `splitAnswer=false`、`holdStreamInProcess`）
- `apps/electron/src/renderer/components/chat/concise-timeline-model.ts:439-570`（`buildConciseTimeline`，tone `:561-562`）
- `apps/electron/src/renderer/components/chat/regress-b-progress-live.vitest.test.ts:198-257`（B 历史轮单测，未复现真实形状）
- `packages/shared/src/utils/output-style-prompt.ts:14,17,18`（prompt 抑制·次因）
- 实测数据：`C:/Users/liangmingxuan/.tagent/agent-sessions/6cc114a0-*.jsonl` 等 4 会话（2026-07-24，早于 369d6f7）
