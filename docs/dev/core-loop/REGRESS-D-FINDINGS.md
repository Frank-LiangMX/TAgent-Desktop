# REGRESS-D Findings — 思考链流式滚动跟随 + 结束后优雅折成「思考了 Ns」且可再打开

> 规格：`docs/dev/core-loop/CURSOR-CONCISE.md` §验收 8
> 派工：`docs/dev/core-loop/REGRESS-D-thinking-fold-brief.md`
> 范围：仅 `displayMode === 'concise'` 的 `ThinkingFold` + 必要 CSS；`full` / ProcessGroupView 零回归

## 现象 ↔ 根因 ↔ 改法

### A. 流式滚动不跟随（最新思考看不见）
- 根因：`.agent-concise-fold__body` 有 `max-height: 220px; overflow: auto`，流式往 body 追加文字却没有把 `scrollTop` 钉到底。
- 改法（`ConciseTimelineView.tsx` `ThinkingFold`）：
  - body 加 `ref` + `onScroll`；新增 `stickRef` 记录是否贴底。
  - `isLive` 且 `displayedContent` 增长时，若 `isNearBottom(scrollTop, scrollHeight, clientHeight)`（距底 ≤ 40px）→ `scrollTop = scrollHeight` 钉底跟随。
  - 用户主动上滚离开底部 → `stickRef=false` 暂停跟随；回到底部（`onScroll` 再判定贴底）恢复。
  - `isNearBottom` 抽成纯函数 `thinking-scroll-follow.ts`（无 DOM 依赖，单测覆盖）。
- 效果：live 长思考超过 220px 时，未手动上滚则最新字始终在 fold 可视底。

### B. live→idle 秒折 / 正文瞬间消失
- 根因：`ThinkingFold` 在 `wasLive.current && !isLive` 时立刻 `setOpen(false)`，且 `{open ? body : null}` → 折起即从 DOM 删 body，无过渡，用户体感「秒没」。
- 改法（`ConciseTimelineView.tsx` `ThinkingFold`）：
  1. 禁止秒折：live→idle 不立即 `setOpen(false)`，改为 `settleTimer` 保持展开 `THINK_SETTLE_MS = 1800ms`（区间 1.5–2.5s）后再 `setOpen(false)`。
  2. body 常驻 DOM：`{open ? body : null}` → `<div className="agent-concise-fold__panel {is-open?}"><div className="...panel-inner"><div className="...fold__body">…</div></div></div>`，用 CSS `grid-template-rows 0fr↔1fr` + `opacity` 过渡折起，不 `null` 卸载；折起后点开头栏仍见全文（内容常驻 DOM，整轮结束后仍在）。
  3. settle 期间用户手动点收起 → `handleToggle` 清掉 `settleTimer`，尊重用户，不夺回刚展开的状态。
- CSS（`styles/chat.css`）：新增 `.agent-concise-fold__panel`（grid 0fr/1fr + opacity 过渡）、`.agent-concise-fold__panel-inner`（`overflow: hidden; min-height: 0`）；`prefers-reduced-motion` 下 `transition: none`。

### C. 思考完成后无阶段性总结观感（应对齐 Cursor「思考了 Ns」）
- 根因：`ThinkingFold` 的 `isLive = isLive && isLastOfKind(..., 'thinking')` —— leading / 独立思考在工具开始后仍是「最后一条 thinking」，`isLive` 直到整轮结束才转 false，故工具阶段一直显示 `思考中 Ns` 扫光，看不到 `思考了 Ns` 总结；整轮结束才秒折。
- 改法：`isLastOfKind` → `isLastSegment`（seg 是否为过程队列末位）。工具/正文一旦跟上，思考不再是末位 → `isLive` 转 false → 走 B 的 settle，头栏即收成 `formatThinkingSummary(durationSec)`（`思考了 Ns / 思考了片刻`），扫光停；正在流式的末位思考仍 live（`思考中 Ns` + 展开 + 钉底跟随）。
- 效果：思考结束（工具开始）→ settle → 折成「思考了 Ns / 片刻」灰字头；不点开也能看到这行总结，点开能回看全文。

### D. 与 REGRESS-C 边界
- 未回退「阶段内普通思考进 `work_stage.steps`」（`buildConciseTimeline` thinking 分支不动）。
- leading / 独立 `ThinkingFold` 满足 A–C；其 `isLive` 在工具开始后变 false 时走 B 的 settle，整段 segment 不被删（视图只渲染 segments，模型不删段）。
- `WorkStageFold` 的 `useLiveStatusHold` / `keepWhileActive` / `lastWorkStageIdx` 等节奏逻辑零改动。

## 改动文件

- `apps/electron/src/renderer/components/chat/ConciseTimelineView.tsx`（`ThinkingFold` + `isLastSegment`，替换 `isLastOfKind`）
- `apps/electron/src/renderer/components/chat/thinking-scroll-follow.ts`（新：`isNearBottom` / `STICK_THRESHOLD` 纯函数）
- `apps/electron/src/renderer/components/chat/thinking-scroll-follow.vitest.test.ts`（新：距底跟随纯函数测）
- `apps/electron/src/renderer/styles/chat.css`（`.agent-concise-fold__panel` / `__panel-inner` + reduced-motion）
- `docs/dev/core-loop/CURSOR-CONCISE.md`（§1 表格 +思考折叠行；§3 验收 +第 8 条）

## 验收

1. live 长思考超过 220px：未手动上滚时最新字始终在 fold 可视底（钉底跟随）。
2. 思考结束 → settle ~1.8s → CSS 过渡折成「思考了 Ns / 片刻」；不瞬间空白。
3. 折起后点击仍能展开全文；整轮结束后仍在。
4. `thinking-scroll-follow` vitest 绿；`apps/electron` typecheck 绿；现有 concise / regress-b 用例不回退。

## 不做

- 不改 permission / REGRESS-A/B 流式双源 / 主进程 IR
- 不强制改 full ProcessGroupView
- 不 commit / push
