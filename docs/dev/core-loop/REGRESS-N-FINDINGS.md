# REGRESS-N FINDINGS — 阶段性总结顽固闪没：根因 = REGRESS-J 的 idle `isShortIdleProgress → continue`

> 日期：2026-08-08 ｜ 工作区：`C:\Users\loumi\Desktop\AI\TAgent-Desktop` ｜ 分支 `main`（未 commit）
> 规格：`docs/dev/core-loop/REGRESS-N-progress-vanish-stubborn-brief.md`
> 层：数据投影 `concise-timeline-model.ts` / 视觉 `ConciseTimelineView.tsx` / commit `stream-item-model.ts` / 装配 `Chat.tsx`
> 范围：仅改 concise 时间线（投影 + 视图 + 测试 + 文档）；**未动任何 MoA 文件**；未 commit。

---

## 0. 根因一句话

**REGRESS-J(J1/J4) 的 `isShortIdleProgress → continue`（按长度 ≤20 字一刀切）在 idle 重投影时把「正在跑验证」「准备编辑」这类有信息的段间短 progress 直接丢掉，撤销了 REGRESS-M 的 `tool_start` commit——live 打字机可见、idle 重投影即被吃，用户观感「阶段性总结流完即消」。**

长度阈值无法区分「好的」级 filler 与有信息短句，于是同一规则要么吞掉短总结（消失）、要么被长总结 flushStage 拆碎（碎成「运行了 1 条命令」）——B/J/M 三个批次目标互撕的来源。

---

## 1. 必须回答（取证，带行号）

### Q1：段间总结在 process 里是 `text` 还是 `thinking`？idle 是否命中 `isShortIdleProgress` 被 `continue`？

- **是 `text`**。REGRESS-K(K1.1) 已钉死：全核 reasoning→thinking 映射正确，思考恒走 `thinking` 块；段间进度/旁白走 `text` 块。`buildTurnPresentation`（`session-turn-model.ts:645-648`）按 `block.type` 分流，`text`→`process` text 条目；`buildConciseTimeline` 的 narrative 只来自 `text` 条目（`concise-timeline-model.ts:617-636`）+ `mergeAnswerIntoProcess`（`:419-472`，不含 thinking）。
- **idle 命中并被 `continue` 丢掉**——改前 `concise-timeline-model.ts:604-605`：
  ```ts
  const isShortIdleProgress = !isLive && !isRoundFinal && isShortProgressText(cur.text)
  if (isShortIdleProgress) continue
  ```
  `isShortProgressText` 仅按长度（`SHORT_PROGRESS_MAX_CHARS=20`，`:392`）。短且有信息（如「正在跑验证」5 字、「准备编辑」4 字）在 idle（`!isLive`）且非回合末（`!isRoundFinal`）时被 `continue` 整条丢弃。
- **与 REGRESS-M 的互撕**：`Chat.tsx:1360-1367` 的 `tool_start` 先 `commitStreamTextToLastAssistant(prev, pendingText)` 把段间 progress 插到末条 assistant 的 tool_use 前（`stream-item-model.ts:197-201`，位置正确），再清 `streamState.text`。于是 live 期间该 text 经 `holdStreamInProcess`（`session-turn-model.ts:739-774`）进 process、`buildConciseTimeline(isLive=true)` 走 text 分支 → **isLive=true 使 `isShortIdleProgress` 不成立 → flushStage + pushNarrative(progress)**，打字机可见。回合结束 `turn_end`（`Chat.tsx:1368-1390`）置 `isLive=false`，重投影同一 process：短 text 再次命中 `isShortIdleProgress` → `continue` → **总结消失**。即 brief 所述「M commit 进 items 后，idle 投影仍被 J 丢掉 → 看起来 M 没生效」。

### Q2：为何碎成多个「运行了 N 条命令」——分隔符是长 progress / 独立 thinking fold / 别的？

- **分隔符是长 progress（>20 字）触发的 `flushStage`**。改前 text 分支：短 progress 被 `continue`（丢、不拆 stage → 合并）；**长** progress（`isShortProgressText=false`，如「目录摸清了：问题在投影层，下一步改 concise 模型。」24 字）不被丢 → 落到 `flushStage()`（改前 `:606`）→ 当前工具 stage 就地收口、下一工具起新 stage → 每个长 progress 拆一次 stage → 碎成多个「运行了 1 条命令」。
- **不是独立 thinking fold**：REGRESS-K1/J3 已把中段思考并入 `stage.steps`（`concise-timeline-model.ts:560-568`，`stageSteps.some(tool)` → push thinking step，不 `flushStage`），思考不再拆 stage。
- 故截图「碎 + 消失」同源而互斥：J1 用「长度」一刀切——短则吞（消失）、长则拆（碎）。`isShortProgressText` 阈值恰是两者边界，模型一句话长短横跨即触发不同症状。

### Q3：大空白 DOM 来自哪个 segment/CSS？

- **最可能：`agent-concise-narrative--progress` 空占位 + 碎 stage 的 `gap` 叠加。**
  - `NarrativeSmoothBody` progress 分支改前（`ConciseTimelineView.tsx:762-774`）恒渲染外层 `<div className="agent-concise-narrative agent-concise-narrative--progress">`，其 CSS `padding: 1px 0`（`chat.css:795-797`）；当 `displayedContent` 暂空（live→idle one-shot `seed=''` 重置帧、或流式 `useSmoothStream` 收缩过渡）时，内层 `MessageResponse` 不渲染，外层空 div 仍占 `padding` 行。多个段间 progress 在 live→idle 重投影增删时，这种空壳易叠出肉眼可见的留白（brief「疑似空 narrative / 被吃掉的进度占位」）。
  - 次因：`agent-concise-run__body` 的 `gap: 6px`（`chat.css:632-642`）+ `agent-concise-narrative--final` 的 `margin-top: 8px`（`chat.css:805-811`）在「只剩碎灰字 stage」时把阶段行彼此拉开、与正文拉开，呈现为大段空白。
- **未能用本机 live DOM/JSONL 100% 复现单一触发点**（截图无 DOM 快照，`~/.tagent` 无今日对应会话可回放）。但「空占位 div」是可在代码层钉死的「占位」源，已按 brief「无内容勿占位」修掉（见 §2.3）。修后总结常驻、空壳不渲染，空白随碎 stage 一并收敛。

### Q4：`commitStreamTextToLastAssistant` 是否把 text 插到正确位置？随后是否被 J 或 dedupe 吃掉？

- **位置正确**：`stream-item-model.ts:197-201` 取 `content.findIndex(b=>b.type==='tool_use')`，`splice(toolIdx, 0, block)` 插到第一个 tool_use 前 → 过程链顺序 = 总结 → 工具。`:192-195` 已有「相同/互为前缀 → 视为已落盘，防双份」守卫。
- **随后被 J 吃（短）/ 被 dedupe 吃（与 final 同前缀）**：
  - 短 text：idle 被 J1 `isShortIdleProgress → continue` 丢（见 Q1）。
  - 若 text 与回合末 final 互为前缀，`buildTurnPresentation` 的 `answerOverlay` 去重（`session-turn-model.ts:781-802`，`t === answerOverlay || answerOverlay.startsWith(t)`）会把它从 process 里 `splice` 掉。concise 下 `splitAnswer=false`、`answerTexts=[]`（`:619-625,817`），尾部 text 全留 process；段间独立 progress 一般非 final 前缀，不命中，但极端同前缀句会被吃——属已知边角，不在本轮主修。

---

## 2. 产品裁决落码（按 brief「产品裁决」+「必改」）

### 2.1 改写 J1 idle-drop（必改 1，主修）— `concise-timeline-model.ts`

- 新增 `isFillerProgressText`（`:400-417`）：**仅纯 filler**（好的/嗯/ok/继续/然后/接下来…极短无信息过渡词，正则 `^(好的|好|嗯|…|下一步)\s*[punct]*$` + 长度 ≤16）可吞；带动词对象/状态/结论的不算 filler。与 `isTrivialThinking` 同源但更窄。
- 改写 text 分支（`:617-636`）：
  ```ts
  const isRoundFinal = i > lastToolIdx || lastToolIdx < 0
  const isFiller = !isRoundFinal && isFillerProgressText(cur.text)
  if (isFiller) continue
  flushStage()
  const tone = i < lastToolIdx || isLive ? 'progress' : 'final'
  pushNarrative(segments, cur.key, cur.text, tone)
  ```
  - **不再** `continue` 丢有信息段间 progress；仅 filler 跳过以合并阶段。
  - **live/idle 同一套 segments 语义**（去掉旧的 `!isLive` 门控）——filler 在 live/idle 都不渲染，有信息句在 live/idle 都常驻 `narrative.progress`（live 仍由 `useSmoothStream` 打字机）。
  - 回合末 `isRoundFinal` 即便字面是 filler 也保留（可能是用户短回答，不得丢）。
- `isShortProgressText` 保留（live/测试仍用，`:384-398`），不再作 idle 丢弃判据。

### 2.2 中段思考可见性（必改 2）— `ConciseTimelineView.tsx`

- 选 brief「或」的**前者**：折叠 stage 摘要带「· 含思考」**不**升独立 ThinkingFold（避免回退 J3 的拆 stage / 思考游离 / remount 闪）。
- `WorkStageFold` 新增 `hasSubstantiveThinking = steps.some(s => s.kind==='thinking' && !isTrivialThinking(s.thinking))`（`:436-439`），摘要行在 summary 后补 `<span className="text-muted-foreground/45 text-[11px]">· 含思考</span>`（`:491-493`）。仅含**非 trivial**（有分量）思考才提示，纯「让我看看」级不刷。点开 stage 即见完整思考（`stage.steps` 已收全文，J3 不动）。

### 2.3 查清空白 + 无内容勿占位（必改 3）— `ConciseTimelineView.tsx`

- `NarrativeSmoothBody` progress 分支改为 `if (!content) return null`（`:770-783`）：`displayedContent` 暂空时**不渲染空 padding div**，消除占位空白。hooks（`useSmoothStream`/`useEffect`）仍在上方无条件调用，仅控制渲染输出，打字机不受影响。返回类型放宽为 `JSX.Element | null`（`:751`）。
- 顺带修该文件一处**预存 TS 报错**（与本轮无关但同文件，1 行安全修）：`StageStepRow` 的 `stepDurationSec` 工具分支原 `: step.durationSec` 在「tool」变体上访问不存在属性（TS2339，HEAD 即有）；工具行不读 `durationSec`（`getWorkStepLabel` 仅思考读），改为 `: undefined`（`:653-656`），行为不变。

### 2.4 文档（必改 4）

- 新建 `docs/dev/core-loop/HANDOFF-2026-08-08.md`：写明「J1 idle-drop 已否决」+ 验收清单。
- `docs/dev/core-loop/REGRESS-J-FINDINGS.md` 末尾追加「REGRESS-N 否决」注记（J1/J4 的 `isShortIdleProgress → continue` 不再适用）。

---

## 3. 改动文件

| 文件 | 改动 | 行 |
|------|------|----|
| `apps/electron/src/renderer/components/chat/concise-timeline-model.ts` | 新增 `isFillerProgressText`；改写 text 分支（filler-only 跳过；有信息 progress 常驻） | `:384-417`, `:617-636` |
| `apps/electron/src/renderer/components/chat/concise-timeline-model.vitest.test.ts` | J4 测试改 filler+合并；新增「idle ≥2 progress」验收测试；import `isFillerProgressText` | 顶部 import, 原 J4 用例 → 两个新用例 |
| `apps/electron/src/renderer/components/chat/regress-b-progress-live.vitest.test.ts` | idle 断言改为保留 2 个 progress + 1 final（否决 J4 idle-drop） | `:192-197`, `:253-258` |
| `apps/electron/src/renderer/components/chat/ConciseTimelineView.tsx` | 「· 含思考」提示；progress 空内容 `return null`；修预存 `stepDurationSec` TS 错 | `:436-439`, `:491-493`, `:653-656`, `:770-783`, `:751` |
| `docs/dev/core-loop/REGRESS-N-FINDINGS.md` | 本文件 | — |
| `docs/dev/core-loop/HANDOFF-2026-08-08.md` | 交接 | — |
| `docs/dev/core-loop/REGRESS-J-FINDINGS.md` | 末尾注记被 N 否决 | 末尾 |

**未动**：`stream-item-model.ts`、`Chat.tsx`、`session-turn-model.ts`、`chat.css`（只读取证确认）、所有 MoA 工作树文件（`moa-*`/`moa-roundtable*`/`moa-preset*`/`MoaRoundtableCard.tsx` 等）。

---

## 4. 测试（vitest）

```
npx vitest run apps/electron/src/renderer/components/chat/
```

- `concise-timeline-model.vitest.test.ts`：28 passed（含新增「有信息的短段间 progress 不被 idle 丢：idle 含 ≥2 个 narrative.progress」「纯 filler 段间短文不拆 stage」）
- `regress-b-progress-live.vitest.test.ts`：4 passed（idle 断言改为 `['progress','progress','final']` / `['正在摸清目录','准备编辑','完成。']`）
- 其余 7 个 chat 测试文件全绿，合计 **166 passed / 0 failed**。
- `bun run --filter @tagent/electron typecheck`：**0 error**（含顺带修的 `stepDurationSec`）。

验收对照：
1. ✅ 合成序列 `think→tool→text(短进度)→tool→text(短进度)→tool→text(长结论)`，`isLive:false` → segments 含 **2 个 `narrative.tone=progress`**（短有信息句不被丢）。
2. ✅ 仅 filler「好的」夹在两 Bash 之间 → idle 合并为 **1 个 work_stage**（`运行了 3 条命令`，不增加多余 narrative）。

---

## 5. 手测步骤（实机）

> 前置：rebuild + 重启 TAgent-Desktop（排除 build-lag）；新会话切 **concise** 模式。

1. 发一条会触发「长思考 → 工具 → 段间短总结 → 工具 → 段间短总结 → 工具 → 最终正文」的任务（如「读 concise-timeline-model.ts，说下投影逻辑，再跑下测试」）。
2. **live**：每段短总结以打字机即时出现（深色 progress 短文）；底部「运行中…」扫光。
3. **回合结束（idle）**——对照截图失败点，验收三件：
   - 段间短总结（「正在跑验证」「改完核心逻辑」…）**仍在**为深色 progress 短文，**不**「流完即消」。
   - 阶段灰字行（「探索了 N…，运行了 K 条命令」）与 progress 短文交替，对齐 Cursor 布局；含思考的阶段摘要带 **「· 含思考」**，点开可见完整中段思考。
   - 阶段之间 / 阶段与正文之间**无大空白**（progress 空壳不再占位）。
4. 发新一轮 → 上一轮收成「运行了 X」灰字折叠块；再点开仍见 progress 短文 + 「· 含思考」+ 阶段明细，不丢。
5. 反例（filler 合并）：模型若只发「好的」「继续」级过渡词夹在连续 Bash 之间，idle 应合并成单一「运行了 N 条命令」，不刷多余 narrative（验收 2）。

失败时：抓该轮 live `.messages.jsonl`（`~/.tagent*/projects/<proj>/session-*.messages.jsonl`）+ 截图，对照本 FINDINGS §1 四问逐条定位。

---

## 6. 备注

- 本轮未 commit（遵 brief）。MoA 工作树改动（`moa-dispatch*`/`run-moa-turn*`/`moa-preset-service*`/`MoaRoundtableCard.tsx`/`packages/shared/src/types/moa-*` 等）一概未碰。
- 「大空白」未拿到本机 live DOM 单点钉死（无截图 DOM / 无今日会话 jsonl）；按 brief「无内容勿占位」在代码层消掉空占位 div，碎 stage 的 gap 随总结常驻而收敛。若实机仍见空白，优先抓 live `.messages.jsonl` 看 `text` 块是否被 `answerOverlay` 前缀去重吃掉（§1 Q4 边角）。
