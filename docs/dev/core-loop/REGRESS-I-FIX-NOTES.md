# REGRESS-I FIX-NOTES — 最小修改动点

> 对应 REGRESS-I-FINDINGS.md 的 A/B/C 三根因。三文件正交，同轮并修。已 vitest + tsc 验证零回归。未 commit/push（brief + kscc-prompt 禁止）。

## A. 中间思考闪没又出现（concise live 归类跳变）
**文件**：`apps/electron/src/renderer/components/chat/concise-timeline-model.ts`（`buildConciseTimeline` 循环体 `:516`/`:519`）

before：
```ts
if (isTrivialThinking(t)) continue
// 普通中段思考且当前阶段已有工具 → 并入 stage steps ...
if (!isDeliverableThinking(t) && stageSteps.some((s) => s.kind === 'tool')) {
```
after：
```ts
// live 时不丢弃 trivial 思考：流式思考逐帧跨越 trivial 阈值会被丢（=消失）再长回（=出现），
// 面板不停闪。回合 idle 后再按终态丢弃短思考。
if (isTrivialThinking(t) && !isLive) continue
// ... live 时一律并入 stage（key=cur.key 稳定，不与独立 fold 的 think-${cur.key} 互跳 remount），
// 避免"思考→工具"切换时思考从独立 fold 跌回 stage step 触发整段重排闪；idle 后可交付才升独立折叠。
if (stageSteps.some((s) => s.kind === 'tool') && (!isDeliverableThinking(t) || isLive)) {
```
- 原理：live 期间中段思考恒为 stage step（key=`cur.key` 稳定，不 remount、不消失）；idle 后按终态重排。
- idle 等价：`!isLive` 时退化为 `isTrivialThinking(t)` / `!isDeliverable && stageSteps.some(tool)`，原逻辑不变。

## B. 阶段思考总结过长（full 折叠态正文预览大长段）
**文件**：`apps/electron/src/renderer/components/chat/ProcessGroupView.tsx`

1. 删折叠态正文预览行（`:395` 原 `{!open && <div className="agent-thinking-row__preview">{buildThinkingPreview(text)}</div>}` 整行删除）。
2. 头栏徽章 idle 显时长（`:366`）：
   before `<span className="agent-thinking-row__badge">思考</span>`
   after  `<span className="agent-thinking-row__badge">{isLive ? '思考' : formatThinkingSummary(durationSec)}</span>`
3. `ThinkingActivityRow` 加 `durationSec?: number` prop（签名 + JSDoc）。
4. 透传：`ProcessGroupView:227-233` 渲染处加 `durationSec={entry.durationSec}`（`entry` 经 `if (entry.type === 'thinking')` narrowing，`durationSec` 可达）。
5. import：`+formatThinkingSummary`（from `./session-turn-model`）、`-buildThinkingPreview`（from `./process-group-model`，函数保留供单测）。
- CSS `agent-thinking-row__preview`（`chat.css:1116-1123`）成未用样式，保留不动（最小修）。

## C. 复制按钮运行中显示
**文件**：`apps/electron/src/renderer/components/chat/AssistantTurnView.tsx`（concise `:299` + full `:355` 两处工具栏外层门）

before：`{copyText || endFooter ? ( ... <MessageCopyButton text={copyText}/> ... ) : null}`
after：`{!processLive && (copyText || endFooter) ? ( ... <MessageCopyButton text={copyText}/> ... ) : null}`
- running 时 `!processLive=false` → 工具栏整体不渲染；idle/历史轮 → 正常显示。内层不变。
- 用 `processLive`（`:98` = `isLiveTurn`）与同文件 `endFooter`/`editedFiles`/`filesCard` 门一致；turn_end 软停期 `running` 瞬 false 但 `processLive` 仍 true，避免软停瞬间闪现。

## 测试新增（锁 A 防回归）
**文件**：`apps/electron/src/renderer/components/chat/concise-timeline-model.vitest.test.ts`（`buildConciseTimeline` describe 末尾 +2 用例）
- `live 时不丢弃 trivial 中段思考（避免逐帧消失又出现），并入 stage；idle 后再丢弃`
- `live 时 deliverable 中段思考并入 stage（不升独立 fold 跳 key 闪）；idle 后升独立 fold 打断阶段`

## 验证
- `node node_modules/vitest/dist/cli.js run concise-timeline-model.vitest.test.ts process-group-model.vitest.test.ts` → **60 passed**（24+36）。
- `tsc --noEmit -p apps/electron/tsconfig.json` → **exit 0**。
- 本机 bunx 双 fork → vitest 用 `node node_modules/vitest/dist/cli.js`、tsc 用 `apps/electron/node_modules/.bin/tsc.exe`（原生，关沙箱）。

## 未做
- 未 commit/push（brief `不 commit` + kscc-prompt `禁止 commit/push`）。
- CSS `__preview` 死样式未删（最小修，无报错）。
- 未跑整轮 GUI 视觉验证（vitest + tsc 已锁数据/类型层；GUI 闪烁/复制按钮可见性建议人工跑一轮确认）。
