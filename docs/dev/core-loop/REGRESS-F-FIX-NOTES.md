# REGRESS-F FIX NOTES — full 思考 settle + RC1 rAF flush

> 日期：2026-08-07
> 规格：`REGRESS-2026-08-07-RESIDUAL-SPEC.md` §F
> 依据：`REGRESS-F-implement-brief.md` / `REGRESS-F-FINDINGS.md`
> 范围：本轮实现 + 单测 + typecheck。**未 commit / 未 push**（遵循 brief「不 commit / push」）。

## 0. 一句话结论

默认 `full` 模式下，最后一段正在流式的思考在 `live→false` 瞬间被 `{open ? body : preview}` 硬切换、body 立即卸 DOM 换 4 行预览——这是用户说的「立刻消失（非 settle 后折成思考了 Ns）」。本轮把 concise `ThinkingFold` 已验证的 **settle + body 常驻** 移植到 full 的 `ThinkingActivityRow`，并补上 RC1（`turn_end`/`result` 提交前漏 flush rAF 思考 batch）。concise `ThinkingFold` 零改动、零回归。

---

## 1. 改了什么

### 1.1 主因 — full `ThinkingActivityRow` settle + body 常驻

`apps/electron/src/renderer/components/chat/ProcessGroupView.tsx` `ThinkingActivityRow`：

- **settle**：新增 `settled` state + `wasLiveRef` + `settleTimerRef`，`useEffect([isLive])` 经纯函数 `planThinkingRowSettle` 决策：
  - `arm`（新一轮 live）：`settled=false`（武装，结束时再走 settle 窗口）。
  - `settle`（live→idle）：起 `THINKING_ROW_SETTLE_MS=1800` 定时器，到期才 `settled=true`；cleanup 清定时器（工具间隙 live 抖回 → 取消待折）。
  - `noop`（仍 live / 仍 idle）：不动。
- **autoOpen**：`displayMode==='concise' ? false : isLive || !collapsible || !settled`。
  - full live → 展开；full idle 短文（`!collapsible`）→ 恒展；full idle 长文 → settle 窗口内（`!settled`）仍展、过后折。
  - concise 恒 `false`——settle 不影响 concise 分支，零回归。
- **body 常驻 DOM**：去掉 `{open ? <body> : <preview>}` 硬切。body 包进 `__panel`（`grid 0fr↔1fr` + `opacity`）+ `__panel-inner`，**永不 null 卸载**；折起后点开头栏仍见全文。`__preview` 仅在 `!open` 时作为折叠态摘要渲染。
- **用户手动 toggle**：清 `settleTimerRef`，`setUserExpanded(!open)`（沿用原 `userExpanded` override 语义，不改组级状态机）。
- `shouldCollapseThinking` 仍只决定「是否可折」，不再决定 body 卸载。

### 1.2 CSS — `.agent-thinking-row__panel` grid 过渡

`apps/electron/src/renderer/styles/chat.css`：

- 新增 `.agent-thinking-row__panel` / `.agent-thinking-row__panel.is-open` / `__panel-inner`，逐字对齐 `.agent-concise-fold__panel`（`grid-template-rows 0fr↔1fr` + `opacity` + `transition 0.28s/0.2s ease`；`panel-inner` `overflow:hidden; min-height:0`）。
- 新增 `@media (prefers-reduced-motion: reduce) { .agent-thinking-row__panel { transition: none } }`（对齐 concise「settle 折起交给状态切换，不要过渡抢动」）。
- `.agent-thinking-row__body` / `__preview` 原样保留（body 现位于 `__panel-inner` 内，常驻不卸载；preview 仍是折叠态 4 行/200 字纯文本预览）。

### 1.3 次因 RC1 — `turn_end` / `result` 提交前 flush rAF

`apps/electron/src/renderer/components/chat/Chat.tsx`：

- `result`（约 1208-1224）与 `turn_end`（约 1299-1314）在 `commitStreamThinkingToLastAssistant` **之前**复制 `sdk_message` 分支（约 1183-1189）的 rAF flush 守卫：
  ```ts
  if (thinkingFlushRafRef.current != null) {
    cancelAnimationFrame(thinkingFlushRafRef.current)
    thinkingFlushRafRef.current = null
  }
  const pendingDelta = pendingThinkingRef.current
  pendingThinkingRef.current = ''
  pendingThinkingUuidRef.current = undefined
  const pendingThink = (streamStateRef.current.thinking + pendingDelta).trim()
  if (pendingThink) setItems((prev) => commitStreamThinkingToLastAssistant(prev, pendingThink))
  resetStreamState()
  ```
- 修复：`stream_thinking_delta` 按 rAF 合帧缓冲进 `pendingThinkingRef`，rAF 未 fire 时不进 `streamState`。原 `turn_end`/`result` 直接读 `streamStateRef.current.thinking`（漏 pending batch），随后 `resetStreamState()` 又清掉 `pendingThinkingRef` → 同帧到达、尚未 rAF flush 的末段思考增量被永久丢弃。现把 `pendingDelta` 折进提交值，pending batch 不再丢。
- 其后 `purgeStreamingItems` / `scheduleRunStop` / `beginStreamTransition` 等不变。

### 1.4 纯逻辑抽函数（可单测）

`apps/electron/src/renderer/components/chat/process-group-model.ts`：

- 新增 `THINKING_ROW_SETTLE_MS = 1800`（对齐 concise `THINK_SETTLE_MS`，1.5–2.5s 区间）。
- 新增纯函数 `planThinkingRowSettle({isLive, wasLive})` → `'arm' | 'settle' | 'noop'`，供组件 effect 调用、供单测。

### 1.5 单测

`apps/electron/src/renderer/components/chat/process-group-model.vitest.test.ts`：新增 `describe('planThinkingRowSettle (REGRESS-F)')` 4 例（arm / 持续 live noop / settle / 持续 idle noop）。`process-group-model` 用例 32 → 36。

---

## 2. 改动文件清单

| 文件 | 性质 |
|---|---|
| `apps/electron/src/renderer/components/chat/process-group-model.ts` | +`THINKING_ROW_SETTLE_MS`、+`planThinkingRowSettle`（纯函数） |
| `apps/electron/src/renderer/components/chat/ProcessGroupView.tsx` | `ThinkingActivityRow` settle + body 常驻（重写组件体；head/toggle/scroll 语义保留） |
| `apps/electron/src/renderer/styles/chat.css` | +`.agent-thinking-row__panel/__panel-inner` + reduced-motion |
| `apps/electron/src/renderer/components/chat/Chat.tsx` | RC1：`result` / `turn_end` 提交前 flush rAF |
| `apps/electron/src/renderer/components/chat/process-group-model.vitest.test.ts` | +`planThinkingRowSettle` 4 例 |

未改：`ConciseTimelineView.tsx`（concise `ThinkingFold`）、`stream-item-model.ts`（E 数据层）、`kscc-message-adapter.ts`、`session-turn-model.ts`、组级折叠状态机 `planProcessGroupCollapse`、`chat-display-prefs.ts`（默认仍 `full`）。

---

## 3. 测了什么（stdout 实证）

### vitest（6 文件 / 101 用例全绿）

```
 ✓ thinking-scroll-follow.vitest.test.ts (5 tests)
 ✓ stream-item-model.vitest.test.ts (14 tests)
 ✓ process-group-model.vitest.test.ts (36 tests)   ← 含新增 planThinkingRowSettle 4 例
 ✓ turn-presentation.vitest.test.ts (20 tests)
 ✓ regress-b-progress-live.vitest.test.ts (4 tests)
 ✓ concise-timeline-model.vitest.test.ts (22 tests)
 Test Files  6 passed (6)
      Tests  101 passed (101)
   Duration  3.51s
```

命令：
```
bunx vitest run \
  apps/electron/src/renderer/components/chat/process-group-model.vitest.test.ts \
  apps/electron/src/renderer/components/chat/stream-item-model.vitest.test.ts \
  apps/electron/src/renderer/components/chat/concise-timeline-model.vitest.test.ts \
  apps/electron/src/renderer/components/chat/regress-b-progress-live.vitest.test.ts \
  apps/electron/src/renderer/components/chat/turn-presentation.vitest.test.ts \
  apps/electron/src/renderer/components/chat/thinking-scroll-follow.vitest.test.ts
```

（`apps/electron` 下仅此 6 个 `*.vitest.test.ts`，已全覆盖。）

### typecheck

```
bun run --filter='@tagent/electron' typecheck   →  Exited with code 0
```

---

## 4. 手测验收（默认 full，需实机复测）

> 本轮为源码 + 自动化测试；以下为预期行为，待实机点验。

1. **full 长思考 live→idle 不再瞬切**：默认 `full` 下，最后一段正在展开的思考流到 `result`/`turn_end`（`live→false`）时，正文**不再瞬间消失换 4 行预览**；先保持展开 ~1.8s（settle），再 CSS `grid 1fr→0fr` + `opacity 1→0` 平滑折起。
2. **折起后可再展开全文**：settle 过后折成 4 行预览，点开头栏 → body 从 DOM 常驻处重新展开（`grid 0fr→1fr`），全文仍在，无需重新流式/重解析 Markdown。
3. **settle 期间手动收起**：用户在 1.8s 内点收起 → 立即折（取消待执行的强制折起，不夺回用户操作）。
4. **工具间隙 live 抖动**：`live` 瞬时 `true→false→true`（工具循环间隙）不会误触 settle 折起——cleanup 清掉定时器。
5. **concise `ThinkingFold` 行为不变**：concise 走 `ConciseTimelineView`（本轮未碰），其 settle/body 常驻与 1.0 节奏保留。
6. **RC1 末段思考不丢**：concise + 仅 delta 渠道下，与 `turn_end`/`result` 同帧到达、尚未 rAF flush 的末段思考增量现能进 `commitStreamThinkingToLastAssistant` → 不再被 `resetStreamState` 丢弃。GLM（思考写进 content 快照）主体本就靠独立 item 落盘保住，RC1 只补其末段增量。

---

## 5. 约束核对（brief 验收）

| 验收项 | 状态 |
|---|---|
| 1. full：live→idle 有 settle，非瞬间卸 body | ✅ settle 1800ms + body 常驻 DOM |
| 2. concise `ThinkingFold` 行为不变 | ✅ 未改 `ConciseTimelineView`；`ThinkingActivityRow` 的 concise 分支 autoOpen 恒 false、settle 不影响 |
| 3. RC1：turn_end 前 pending thinking 进 commit | ✅ `turn_end`/`result` 复制 rAF flush 守卫 |
| 4. 相关 vitest + typecheck 绿 | ✅ 101/101 + typecheck exit 0 |
| 只动 full `ThinkingActivityRow` | ✅ 未碰 concise / 数据层 / 组级状态机 |
| 不改默认 displayMode | ✅ 仍 `full` |
| 不 commit / push | ✅ 仅工作树改动 |

---

## 6. 未做 / 后续

- **RC2（更边缘，未修）**：`commitStreamThinkingToLastAssistant` 末条 assistant「已有 thinking」即 skip（`stream-item-model.ts:156-158`），晚于最后一条含思考快照的 streamState 增量无处落盘 → reset 丢失。建议实机复测 RC1 后，若仍有「尾部思考丢」再上 RC2（改追加/续写并防重复）。
- **实机点验**：默认 full 长思考 settle 过渡 + 折起后再展开（见 §4）。
- **排除旧包**：若反馈仍「立刻消失」，先确认测试设备跑的是含本修复的构建（非 pre-`369d6f7` 旧包）。
- **未 commit / push**：遵循 brief。如需提交，建议单独一轮：仅含本 5 文件（不含工作树里并行的 REGRESS-G `stream-persist-gate.*` 等未跟踪文件）。
