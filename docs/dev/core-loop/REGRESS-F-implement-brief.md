# REGRESS-F 实现 Brief — full 模式思考 settle + RC1 rAF flush

> 规格：`REGRESS-2026-08-07-RESIDUAL-SPEC.md` §F  
> 依据：`REGRESS-F-FINDINGS.md`（主因 full `ThinkingActivityRow` 硬切；次因 RC1 turn_end/result 未 flush rAF）  
> 派工：本机 `kscc -p --dangerously-skip-permissions`  
> **本轮实现 + 单测**；不 commit / push。

## 必做

### 1. 主因 — full `ThinkingActivityRow` settle + body 常驻

对照 concise 已修模板：`ConciseTimelineView.tsx` `ThinkingFold`（`THINK_SETTLE_MS≈1800`、settle timer、`__panel` grid 0fr↔1fr）。

改：

- `apps/electron/src/renderer/components/chat/ProcessGroupView.tsx` `ThinkingActivityRow`
  - `wasLive` + settle：`isLive` true→false 不立刻折，保持展开 ~1.8s 再收；用户手动 toggle 取消定时器
  - 去掉 `{open ? body : preview}` 硬切；body 常驻 DOM，CSS panel 过渡；折起后点开头栏仍见全文
- `apps/electron/src/renderer/styles/chat.css`：为 `.agent-thinking-row` 加 `__panel` / `__panel-inner`（对齐 `.agent-concise-fold__panel`，含 `prefers-reduced-motion`）
- 常量可抽共享或复用现有 settle ms；`shouldCollapseThinking` 仍决定「是否可折」，不决定卸载 body

**约束**：只动 full 路径 `ThinkingActivityRow`；concise `ThinkingFold` 零回归；组级折叠状态机不动；不碰数据层除非 RC1。

### 2. 次因 RC1 — turn_end / result 提交前 flush rAF

`Chat.tsx`：`sdk_message` 分支已有 `cancelAnimationFrame` + 合并 `pendingThinkingRef`（约 1183-1189）。  
`turn_end` / `result` 在 `commitStreamThinkingToLastAssistant` **之前**复制同一套 flush，避免同帧 delta 被 `resetStreamState` 丢掉。

### 3. 测试

- 能单测的：settle 纯逻辑 / process-group 相关；RC1 若可抽纯函数则测
- 至少跑：`thinking-scroll-follow`、`stream-item-model`、`concise-timeline-model`、`regress-b-progress-live`、electron typecheck
- 不回退 D/E/G

### 4. 文档

写 `docs/dev/core-loop/REGRESS-F-FIX-NOTES.md`：改了什么、测了什么、手测（默认 full：长思考结束 → settle 过渡 → 可再展开全文，非瞬间变 4 行预览）。

## 不做

- 不改 H / AskUserQuestion
- 不改默认 displayMode（仍可为 full）
- 不 commit / push

## 验收

1. full：live→idle 有 settle，非瞬间卸 body  
2. concise ThinkingFold 行为不变  
3. RC1：turn_end 前 pending thinking 进 commit  
4. 相关 vitest + typecheck 绿  
