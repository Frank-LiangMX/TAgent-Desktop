# REGRESS-C Findings — Cursor 式节奏聚合 + live 扫光优雅折进

> 规格：`docs/dev/core-loop/CURSOR-CONCISE.md`  
> 派工：`docs/dev/core-loop/REGRESS-C-cursor-rhythm-brief.md`  
> 范围：仅 `displayMode === 'concise'`；`full` / ProcessGroupView 零回归

## 现象 ↔ 根因 ↔ 改法

### A. 阶段被中段普通思考拆碎
- 根因：`buildConciseTimeline` thinking 分支只区分 trivial / 非琐碎；凡非 trivial 中段思考都 `flushStage()` + 独立 ThinkingFold → 满屏「思考了片刻」+ 阶段被拆。
- 改法（`concise-timeline-model.ts` thinking 分支）：
  - trivial → `continue`（保持）
  - **已有工具且非 `isDeliverableThinking`** → `stageSteps.push({ kind:'thinking', ... })`，不 flush、不推顶层 thinking 段
  - **`isDeliverableThinking`**（或当前阶段无工具时）→ 现有 flush + 独立 ThinkingFold
  - text/progress → 仍 `flushStage`（保持「总结 ↔ 阶段」）
- 效果：`tool → 中段普通思考 → tool → tool` 现在是**一个** work_stage，summary 聚合三族，steps 含 `tool+thinking+tool+tool`；`tool → isDeliverableThinking → tool` 仍是 `work_stage | thinking | work_stage`。

### B. live 扫光闪现秒没 / 执行链弹跳
- 根因：`WorkStageFold` 的 `isLive = isLive && tools.some(!result)`；工具一完成 `liveStatus` 立刻 `undefined` 且零延迟卸 DOM（原 `useDebouncedValue` 对空值是「即清」，并未防消失闪现）。
- 改法（`ConciseTimelineView.tsx`）：
  1. 新增 `useLiveStatusHold(raw, keepWhileActive)`：raw 变空时先 hold 旧值 ~500ms，再淡出 ~250ms（`.is-fading` opacity/max-height/padding transition）后卸 DOM，禁止瞬间 null 卸 DOM。替换原 `useDebouncedValue`。
  2. 末阶段在回合 live 且其后无 narrative 时 `keepWhileActive = true`：持续保持上一个动作扫光（不只「有未完成 tool」）；整轮结束（`stageActive` 转 false）才走 hold→淡出，并收起展开面板成灰字行。
  3. 父层 `ConciseTimelineView` 计算 `lastWorkStageIdx` / `hasNarrativeAfterLastStage`，向 `WorkStageFold` 传 `isStageLive` + `keepWhileActive`（取代单个 `isLive`）。其后已有 narrative 在流时让位给正文（避免双 live 指示）。
  4. 只改 concise；`full` / `ProcessGroupView` 不动。
- CSS（`styles/chat.css`）：`.agent-concise-live-status` 加 `max-height` + `transition`；新增 `.is-fading`（opacity 0 / max-height 0 / padding 0）；`prefers-reduced-motion` 下 `transition: none`。

### C. 满屏「思考了 1s」
- 根因：`formatThinkingSummary` `durationSec > 0` 就「思考了 Ns」。
- 改法（`session-turn-model.ts`）：`durationSec` 缺省或 `< 3` → `思考了片刻`；`>= 3` → `思考了 Ns`。live 文案（`思考中 Ns` / `正在思考…`）不变。

## 验收（自动化，全绿）

- `tool → 中段普通思考 → tool → tool` → 一个 work_stage，summary 聚合，steps 含 thinking+tools
- `tool → isDeliverableThinking → tool` → `work_stage | thinking | work_stage`
- 现有 trivial / progress narrative / summarizeWorkStage 用例绿
- `formatThinkingSummary(1)` → `思考了片刻`；`(46)` → `思考了 46s`
- `bun run test`：78 文件 / 758 用例全绿；`apps/electron` + `packages/shared` + `packages/ui` typecheck 绿

## 不做

- 不改 permission / REGRESS-A/B / 主进程 IR
- 不编造假进度文案（末阶段保持的是「上一个真实动作」扫光，非杜撰）
- 不 commit / push
