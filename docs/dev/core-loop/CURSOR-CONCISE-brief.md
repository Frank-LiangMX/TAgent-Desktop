# CURSOR-CONCISE Brief — Cursor 式简洁时间线

> **状态：已落地（2026-08-06）。** 决策与最终规则见 [CURSOR-CONCISE.md](./CURSOR-CONCISE.md)。  
> 下文保留派工切片，便于对照实现。

---

## 目标

把简洁模式从「过程区逐条工具 + 底部整段回答」改成 Cursor 式时间线：

```
[思考折叠] → [工具簇…] → [穿插正文] → [工具簇…] → [正文] → …
```

- 连续同族工具 → **一行**摘要，点开才见各步  
- 模型中途结论 → **穿插叙事**（回答级 Markdown 流式），不是等 final  

---

## 落地时相对 brief 的修正（讨论决定）

1. **concise 拆分**：`splitAnswer=false`，text 全留 `process`，`answerTexts=[]`（见 CURSOR-CONCISE.md §2.2）。  
2. **思考文案**：不用整轮 `thinkingDurationSec`；固定「思考了片刻」/「正在思考…」。  
3. **投影按时间序**：禁止「阶段内全部 thinking 抽到段首」（会把加粗结论埋进折叠）。  
4. **工具后可交付 thinking**（加粗/标题/结论口吻）→ 升为 narrative；琐碎元思考隐藏。  

---

## W1 — 纯函数投影

**文件** `apps/electron/src/renderer/components/chat/concise-timeline-model.ts`  
**单测** `concise-timeline-model.vitest.test.ts`

```ts
export type ToolFamily = 'explore' | 'edit' | 'shell' | 'other'

export type ConciseSegment =
  | { kind: 'thinking'; key: string; thinking: string; summary: string }
  | {
      kind: 'tool_cluster'
      key: string
      family: ToolFamily
      tools: Array<Extract<ProcessEntry, { type: 'tool' }>>
      summary: string
    }
  | { kind: 'narrative'; key: string; text: string }
```

### `classifyToolFamily(name: string): ToolFamily`

- explore：Read, Grep, Glob, Search, SemanticSearch, WebSearch, WebFetch, …  
- edit：Edit, Write, MultiEdit, NotebookEdit, …  
- shell：Bash, Shell, …  
- other：其余  

### `buildConciseTimeline(process, opts?)`

规则以 [CURSOR-CONCISE.md](./CURSOR-CONCISE.md) §2.4 为准（时间序 + 可交付提升）。

---

## W2 — UI

**文件** `ConciseTimelineView.tsx`；`AssistantTurnView` 在 concise 下只渲染时间线（无独立回答壳）。

---

## W3 — 拆分配合

- full：不动  
- concise：text 留 process；timeline 投影 narrative  

---

## 验收

见 [CURSOR-CONCISE.md](./CURSOR-CONCISE.md) §4。
