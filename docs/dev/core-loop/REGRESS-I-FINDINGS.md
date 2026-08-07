# REGRESS-I 摸底 FINDINGS — 思考闪烁 + 阶段总结过长 + 运行中复制按钮

> 用户原话：中间阶段思考直接消失，过一会又出现，面板不停闪；中间阶段思考总结是大长段好几句，Cursor 更短；运行中就一直显示复制按钮，应完成时才显示。
> 只读摸底 → 根因明确已最小修（见 REGRESS-I-FIX-NOTES.md）。A/B/C 互不踩，同轮并修。

## A. 中间思考闪没又出现（面板不停闪）

### 数据层（无回退，REGRESS-F/D/E 已修点在位）
- **uuid upsert 单真源**：`session-turn-model.ts:507-535` thinking block key=`think-${ownerKey}-${blockIndex}`（ownerKey=message.uuid ?? item.key），partial→final 同 uuid 原地替换（`applySdkMessageToItems:204-228`），key 稳定，不删后重建。
- **preserveAssistantThinking（REGRESS-E）**：`stream-item-model.ts:123-140`，kscc final 剥 thinking 时插回，在位。
- **tool_start 不清 thinking（REGRESS-E）**：`Chat.tsx:1295-1298` 只清 `streamState.text`，不清 thinking。
- **rAF 合帧**：`Chat.tsx:1089-1100`（节流，非删插）。
- **流式 thinking 续写同 key**：`session-turn-model.ts:664-689` 前缀判定原地更新 `process[lastThinkIdx]`，key 不变。
- → **数据层不是根因**。uuid 去重 / preserveAssistantThinking / tool_start 不清 / rAF 合帧 / 单真源续写 全部在位且正确。

### UI 层（根因 — concise 特有新路径）
- **`concise-timeline-model.ts:499-539` `buildConciseTimeline` 中段思考按文本长度逐帧分类**：
  - `:516` `isTrivialThinking(t)` → `continue` **丢弃**（短思考 = 消失）。
  - `:519` `!isDeliverableThinking(t) && stageSteps.some(tool)` → 并入 stage steps（key=`cur.key`，在 WorkStageFold `__panel` 内）。
  - `:528-538` 可交付 / 无 tool → `flushStage()` + 升独立 ThinkingFold（key=`think-${cur.key}`，processSegs 顶层）。
  - 同段流式思考生长中跨越阈值（16 字 / 80 字+前缀 / 100 字+句号 / `**bold**`）→ key 从 `cur.key` 跳 `think-${cur.key}` + 位置从 stage panel 移顶层 → **React remount + 列表重排 = 闪**。
- 阈值：`isDeliverableThinking:334-344`、`isTrivialThinking:346-358`（纯文本长度/内容判定，逐帧变长必跨越）。
- **`ConciseTimelineView.tsx:93`** `isLive = isLive && isLastSegment(processSegs, seg.key)`，末位才 live；`ThinkingFold:206-217` `useState(isLive)` 初始 `open=isLive`，live→idle settle（`:249-267`，`THINK_SETTLE_MS=1800`）后 `setOpen(false)` → 开合抖动。配合分类跳变 = "消失又出现 + 面板不停闪"。
- **full 模式 `ThinkingActivityRow`（`ProcessGroupView.tsx:283-398`）健康**：key=`entry.key` 稳定，body 常驻 DOM（grid 0fr↔1fr + opacity，不 null 卸载），settle 仅 live→idle 一次（`process-group-model.ts:89-96`），`isLive` 由 `entry.key === lastThinkingKey` 收窄（`:231`）→ **full 不是症状 A 路径**。

### 与 REGRESS-F/D/E 关系
- **非回退、非漏网**：F（默认 displayMode=`full`，`chat-display-prefs.ts:18`）、D/E（preserveAssistantThinking / tool_start 不清 thinking / 单真源续写同 key）在位且正确。
- **是新路径（concise 特有）**：concise 独有的"按文本内容动态归类 thinking 到 stage-step / 独立-fold / 丢弃"机制（`concise-timeline-model.ts:499-539` + `:334-358`）是 F/D/E 未覆盖的路径——F 只处理了 full 的 `ThinkingActivityRow` settle 与数据层单真源，concise 的 `buildConciseTimeline` 每帧重分类 + `isLastSegment` 末位 live 翻转是本次独立根因。brief A4 猜的"progress narrative 插入导致列表重排"方向对，但更精确是 **thinking 自身归类跳变**（narrative 插入也触发 flushStage 重排，同机制）。

### 最小修（已实施）
- `:516` → `isTrivialThinking(t) && !isLive`（live 时不丢 trivial，避免短思考逐帧消失又出现）。
- `:519` → `stageSteps.some(tool) && (!isDeliverableThinking(t) || isLive)`（live 时一律并入 stage，key=`cur.key` 稳定不 remount；idle 后可交付才升独立 fold 打断）。
- 效果：live 期间中段思考恒为 stage step（key 稳定），回合 idle 后按终态重排（trivial 丢 / 可交付升独立 fold）。逐帧闪消除；idle 边界一次重排可接受。
- **idle 等价**：`!isLive` 时两守卫退化为原逻辑（`isTrivialThinking(t)` / `!isDeliverable && stageSteps.some(tool)`），既有 22+36=58 测试零回归。

## B. 阶段思考总结过长（大长段，应对齐 Cursor 短）

### 三层各显示什么
- **"思考了 Ns"灰字头**：
  - full 过程组标题 `buildProcessGroupHeaderLabel`（`process-group-model.ts:227-265`）走步数摘要"已执行 N 步 · 含 M 段思考"，不含思考全文。
  - concise `ThinkingFold` 头栏 `ConciseTimelineView.tsx:295-297` 只渲染 `{summary}`=`formatThinkingSummary`（`session-turn-model.ts:850-861`）"思考了 Ns / 片刻"，极短（CSS `nowrap+ellipsis` `chat.css:433-444`）。
- **展开正文**：full `ProcessGroupView.tsx:389-391` `<MessageResponse>` 全文（max-height `chat.css:1108-1113`）；concise `ConciseTimelineView.tsx:313-318` 同全文。
- **step 行摘要**：concise `WorkStageFold:545` `getWorkStepLabel` thinking 分支（`concise-timeline-model.ts:275-279`）→ `formatThinkingSummary`，短。

### "大长段"是哪一层
- **full 模式 `ThinkingActivityRow` 折叠态 `__preview`**：`ProcessGroupView.tsx:395`
  ```tsx
  {!open && <div className="agent-thinking-row__preview">{buildThinkingPreview(text)}</div>}
  ```
- `buildThinkingPreview`（`process-group-model.ts:116-125`）取前 **4 行 / 200 字**原样输出（`THINKING_PREVIEW_MAX_LINES=4` `:101`、`THINKING_PREVIEW_MAX_CHARS=200` `:103`），`white-space:pre-wrap`（`chat.css:1118`）→ 多句灰字大长段。
- 默认 `displayMode=full`（`chat-display-prefs.ts:18`）+ live→idle settle 1.8s（`THINKING_ROW_SETTLE_MS=1800` `process-group-model.ts:23`）后思考行折成此 4 行预览常驻 → 用户看到的"大长段"。
- **concise `ThinkingFold` 折叠态只有头栏"思考了 Ns"，无正文预览行**（`ConciseTimelineView.tsx:287-322` 只 `__head`+`__panel`，无 `__preview`）→ 与"Cursor 更短"完全吻合。

### Cursor 对照
- 唯一把思考正文塞折叠态"摘要"处：`buildThinkingPreview`（`:116-125`），仅 full 消费（`:395`）。**无取首句、无截一行**，是"前 4 行 / 前 200 字"原样截断、保留换行 → 视觉多句灰字大长段。
- 其余摘要路径均已是 Cursor 式短文案：`formatThinkingSummary` / `buildProcessGroupHeaderLabel` / `getWorkStepLabel` thinking 分支 / `summarizeWorkStage` / `liveHint`（`ProcessGroupView.tsx:143-146` 已 48 字截断，但只用于 live 头栏一行）。

### 最小修（已实施）
- 删 `ProcessGroupView.tsx:395` `__preview` 正文预览行（折叠态不再铺正文）。
- 头栏徽章 `:366` idle 时显示 `formatThinkingSummary(durationSec)`"思考了 Ns"（live 时仍"思考"+dot+"进行中"），对齐 Cursor。
- `ThinkingActivityRow` 加 `durationSec?: number` prop，`ProcessGroupView:227-233` 透传 `entry.durationSec`（`ProcessEntry` thinking 类型已含 `durationSec?`，`session-turn-model.ts:65`）。
- import 调整：`+formatThinkingSummary`（`session-turn-model`）、`-buildThinkingPreview`（`buildThinkingPreview` 函数保留供单测，生产不再引用）。
- CSS `__preview`（`chat.css:1116-1123`）成未用样式，保留不动（最小修，无 lint 报错）。

## C. 复制按钮运行中显示

### 复制按钮挂在哪层
- **turn 层 `AssistantTurnView`**：concise 分支 `:299-304`、full 分支 `:355-360`，均 `<MessageCopyButton text={copyText} />`。
- `MessageCopyButton`（`MessageCopyButton.tsx:9-47`）只接 `text`+`className`，无 `isLive`/`disabled`/`hidden`；唯一自裁 `if(!plain) return null`（`:29`）→ `text` 非空即渲染。

### 显隐条件
- 当前：`{copyText || endFooter ? (...) <MessageCopyButton text={copyText}/> ...}`（`:299`/`:355`）。
- `copyText`（`:202-204`）：concise=`joinNarrativeTexts(conciseSegments).trim()`；full=`(answerFull||displayedContent||content).trim()`。
- `endFooter`（`:207-208`）= `!processLive && (completionMs>0 || endClockAt)`，running 时 null。
- **running 期 `copyText` 非空**（concise: `joinNarrativeTexts` 回退分支 `:738-742` 拼所有 narrative 段含 `progress`；full: `streamText`/`displayedContent` 累积）→ 按钮显示。**缺 `!processLive` 门**。

### running 状态来源
- `processLive = isLiveTurn`（`:98`）。`isLiveTurn`（`Chat.tsx:1925-1928`）= `(running || runStartedAt!=null) && 末位 && assistant-turn`。turn_end 软停会短暂 `running=false` 但 `startedAt` 仍存 → `processLive` 仍 true（避免软停瞬间按钮闪现）。

### 最小修（已实施）
- `:299`/`:355` 外层门 → `{!processLive && (copyText || endFooter) ?`（内层不变）。
- running 时 `!processLive=false` → 工具栏整体不渲染（含 `endFooter`，本就 null）；idle/历史轮 `!processLive=true` → 正常显示。
- 用 `processLive` 而非 `isLiveTurn`：同文件 `endFooter`/`editedFiles`/`filesCard` 均用 `!processLive` 门，保持一致；且 turn_end 软停期 `running` 瞬 false 但 `processLive` 仍 true，避免按钮软停瞬间闪现。

## 互踩评估
- A 改 `concise-timeline-model.ts`（live 守卫）、B 改 `ProcessGroupView.tsx`（full 折叠态）、C 改 `AssistantTurnView.tsx`（工具栏门）。三文件不同、逻辑正交，互不踩。
- 与 REGRESS-F/G/H：A 是 concise 新路径（F 只管 full）、B 改 full 折叠态（F 的 settle 不动）、C 加门（不动 `endFooter`/`filesCard`）。无回退。

## 验证
- **vitest**：`concise-timeline-model.vitest.test.ts` 24 + `process-group-model.vitest.test.ts` 36 = **60 passed**（含新增 2 个 live 行为测试锁 A：trivial 不丢并入 stage、deliverable live 并入 stage / idle 升独立 fold）。
- **tsc**：`tsc --noEmit -p apps/electron/tsconfig.json` → exit 0，零类型错。
- 未 commit/push（brief 与 kscc-prompt 均禁止）。
