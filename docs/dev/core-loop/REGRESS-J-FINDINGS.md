# REGRESS-J FINDINGS — 阶段碎裂 / 秒折 / 思考游离 / FilesChanged / FileChip

> 日期：2026-08-07 ｜ 由代码取证，对照 `REGRESS-J-stage-fragment-SPEC.md` 的根因假设逐条判定。
> 层：数据投影 `concise-timeline-model.ts` / 视觉 `ConciseTimelineView.tsx` / `TurnFilesChangedCard.tsx` /
>  路径 `@tagent/shared file-path.ts` + `FilePathChip` / prompt `output-style-prompt.ts`。

## J1 / J4（碎了主因）：无条件 flushStage 拆阶段 — **确诊，主因**

- **证据**：`apps/electron/src/renderer/components/chat/concise-timeline-model.ts` 原 `text` 分支（改前约 559–568）：
  ```ts
  if (cur.type === 'text') {
    if (!cur.text.trim()) continue
    flushLeadingThink()
    flushStage()   // → 每条 text 都就地收口当前 stage
    const tone = i < lastToolIdx || isLive ? 'progress' : 'final'
    pushNarrative(...)
  }
  ```
- **机理**：模型新规鼓励「每段思考后一句进度」（REGRESS-I output-style-prompt），于是「短 progress → flushStage → 下一工具起新 stage」反复循环 →
  「Bash → 一句文 → Bash」被拆成两、三个 `work_stage`，每 stage 只有 1 条命令 → 顶栏「运行了 1 条命令」刷屏（J1）且嘴碎（J7）。
- **判定**：成立。修复改为——极短的非最终段间 progress 在 **idle** 直接忽略（`continue`），工具继续累进同一 stage；`isRoundFinal`（回合末 / 纯文本轮）才 flush 收口并外置 final narrative。live 沿用旧行为（打字机即时可见），回合结束后重投影自然合并。

## J2（阶段秒折）：WorkStageFold 无 settle — **确诊**

- **证据**：`ConciseTimelineView.tsx` 原 `WorkStageFold`（改前约 364–372）对 `stageActive` 的变化直接 `setOpen(false)`，无 settle 定时器；而相邻 `ThinkingFold` 已有 `THINK_SETTLE_MS=1800` + settle（`:249–267`）。且 `agent-concise-stage__panel` 已常驻 grid（`chat.css:390-403`，0fr↔1fr），只需补「结束 hold 一下再折」。
- **判定**：补 `WORK_STAGE_SETTLE_MS=1800`，对齐 `ThinkingFold`/`planThinkingRowSettle`（process-group-model）的节奏；用户手动 toggle 时取消待执行 settle。

## J3（思考游离）：idle 可交付思考升独立 fold — **确诊**

- **证据**：原 thinking 分支（改前约 523–543）：`stageSteps.some(tool) && (!isDeliverableThinking(t) || isLive)` 时并入 stage，否则 `flushLeadingThink(); flushStage();` → 可交付中段思考升成独立 `thinking` fold，顺带 `flushStage` 拆掉当前 tools stage → 思考游离在执行块之外、用户找不到完整思考。
- **判定**：中段思考（当前 stage 已开工具）**一律**并入 `stage.steps`（展开可见全文，`StageStepRow` 已支持 thinking 展开）；仅 leading / 跨阶段边界（无活跃 stage）的大思考保留独立 ThinkingFold。`isDeliverableThinking` 降级为「无活跃 stage 时是否升 fold」的判据。

## J5（Files Changed 丑 / 空 ±）：两处 — **确诊**

- 徽章：`TurnFilesChangedCard.tsx` 原 `FileExtBadge` 只有 react/ts/css/data/file 五类，`kind==='file'` 的 `.cpp/.h/.cs` 落到 label `'·'`（原 80 行）→ 丑陋空点。
- 空 ±：`.agent-files-changed__diff` 在 `add===0 && del===0` 时渲染 `·`（原 55–57）占位。
- ± 为何常 0：`extractToolDiff` 原只认成对 `+N -M`（`concise-timeline-model.ts:103`），结果里只写 `+5` / `removed 3`（单边）时返回 `undefined` → `collectTurnEditedFiles` 落 `{add:0,del:0}`。
- **判定**：扩展名→缩写映射（C++/H/CS/JAVA/…），未知用首字母，禁空 `·`；空 ± 直接**不渲染**；`extractToolDiff` 改单边宽容解析（仍无 → undefined → 隐藏）。

## J6（FileChip 路径 / 混分隔符误判）：**确诊**

- **证据**：`packages/ui/.../file-path-chip/index.tsx` 原 `displayPath` 用 `base + '/' + cleanPath`（改前 135–156）：`base='D:\UnrealTagManager'` + `'Foo/Bar.h'` → `D:\UnrealTagManager/Foo/Bar.h` 混分隔符；tooltip 却拼不出规范化绝对路径。`existsCacheKey`（shared `file-path.ts:81`）不做归一 → 同一文件不同分隔符写法命中不同缓存键。
- **判定**：`file-path.ts` 增 `normalizeFilePathSeparators`（`\`→`/`）+ `joinBasePath`（base+relative 统一分隔符的绝对路径），`existsCacheKey` 先归一；`FilePathChip` 改用 `joinBasePath`。

## J6 复制按钮：**已修（跳过）**

- **证据**：`AssistantTurnView.tsx:299/355` 顶层门已是 `{!processLive && (copyText || endFooter) ? ... <MessageCopyButton ...>`——REGRESS-I 已修，运行中不渲染复制按钮。**本次未重复改**。

## J7（嘴碎 / prompt）：偶发进度一句 — **确诊并收紧**

- **证据**：`output-style-prompt.ts:15` 原「进度一句短文例外」写「**每段思考之后**…可写一句」→ 诱导思考后必接旁白。
- **判定**：改为「仅阶段切换时**偶发**一句；非每段思考后必配；思考后禁止机械接旁白；连续同类工具不写」。与 REGRESS-I 的「多点编号」（:18–21）并存。

## 冲突与取舍

1. **REGRESS-B（live progress 持续可见）vs REGRESS-J（idle 不拆）**：两者若同真冲突。裁决——live 流式保留 progress 打字机（B 测试 1/2 不变），**idle** 才把短段间 progress 收敛进合并 work_stage（B 测试 3/4 的 idle 断言更新，见 FIX-NOTES）。
2. **REGRESS-I「idle 可交付思考升 fold」 vs J3「留在 stage」**：J3 明令改动，`isDeliverableThinking` 升 fold 的 idle 断言被新规格取代（I 加的 live 断言仍保留）。

---

## REGRESS-N 否决注记（2026-08-08 追加）

> 本文件 **J1 / J4** 的核心修法——「idle `isShortIdleProgress → continue` 按长度 ≤20 一刀切丢短段间 progress」——已被 **REGRESS-N** 否决，**不再适用**。详见 `REGRESS-N-FINDINGS.md` / `HANDOFF-2026-08-08.md`。

- **被否决条款**：J1/J4 的 `isShortIdleProgress = !isLive && !isRoundFinal && isShortProgressText(cur.text)` → `continue`（原 `concise-timeline-model.ts:604-605`）。长度阈值无法区分「好的」级 filler 与「正在跑验证」「准备编辑」这类有信息短句，把阶段性总结丢成「流完即消」，并撤销 REGRESS-M 的 `tool_start` commit。
- **取代规则**：`isFiller = !isRoundFinal && isFillerProgressText(cur.text)` → `continue`（`concise-timeline-model.ts:629-631`）。**仅纯 filler**（好的/嗯/继续…极短无信息过渡词）可吞以合并阶段；**有信息进度句一律常驻** `narrative.progress`。live/idle 同一套 segments 语义（去掉 `!isLive` 门控）。
- **J2 / J3 / J5 / J6 / J7 仍有效**：J2（WorkStageFold settle）、J3（中段思考并入 `stage.steps`，不升独立 fold）**保留**——REGRESS-N 只动 J1/J4 的 idle 丢弃，并在此基础上给阶段摘要补「· 含思考」提示（`ConciseTimelineView.tsx`），不回退 J3。
- **测试更新**：`regress-b-progress-live.vitest.test.ts` 的 idle 断言由「只剩 final」改为「2 progress + 1 final」；`concise-timeline-model.vitest.test.ts` 原 J4 用例改为 filler 合并 + 新增「idle ≥2 progress」验收。