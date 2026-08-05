# Cursor 式简洁时间线（已落地）

> 日期：2026-08-06  
> 范围：仅 `displayMode === 'concise'`；`full` 过程区 + 回答壳零回归  
> 代码：`concise-timeline-model.ts` / `ConciseTimelineView.tsx` / `AssistantTurnView` / `buildTurnPresentation`

---

## 1. 产品目标

简洁模式要对齐 Cursor 时间线，而不是「把过程行变矮一点」：

```
[思考折叠] → [工具簇摘要…] → [穿插正文] → [工具簇…] → [正文] → …
```

| 能力 | 行为 |
|------|------|
| 思考 | 默认一行「思考了片刻」/ live「正在思考…」，点开才见全文 |
| 工具 | 连续同族合成一行摘要（探索 / 编辑 / 命令），点开见各步短句 |
| 正文 | 模型中途结论以回答级 Markdown **穿插**在簇之间流式出现 |
| full | 仍为 `ProcessGroupView` 逐条 + 底部回答壳 |

入口：模型选择器旁的过程展示（完整 / 简洁）。

---

## 2. 讨论结论（为什么这样定）

### 2.1 根因不是再调折叠开关

旧简洁仍是 `process[]` 整块 + 底部 `answerTexts`。没有 Cursor 那种 **timeline 段**（thinking / tool_cluster / narrative），所以：

- 工具仍逐条占行  
- 中间结论要么进过程灰字，要么等回合结束才进回答壳  

### 2.2 拆分策略（W3）

| 模式 | `buildTurnPresentation` |
|------|-------------------------|
| **full** | 保持现网：`canSplitStreamingFinal` / 尾部 text 外置回答壳 |
| **concise** | **全部 text 留在 `process`**，`answerTexts = []`，流式正文写入 process text；由时间线投影成 narrative |

避免「过程无 text → 时间线丢穿插」；也避免 concise 再渲染独立回答壳造成双显。

### 2.3 思考不要刷屏，也不要用整轮耗时

实机反馈与决定：

1. **整轮秒数同步到每一段思考**（全是「思考了 28 秒」）→ 错误。整轮耗时只留标题行；折叠文案固定为「思考了片刻」/「正在思考…」。  
2. **think → tool → think → tool** 每段都开折叠 → 过密。  
3. **把阶段内全部 thinking 抽到段首** → 工具之后的加粗结论被埋进思考折叠 → 不可接受。

### 2.4 最终投影规则（按时间序）

阶段由 **`text`（narrative）** 硬切开。阶段内：

| 内容 | 处理 |
|------|------|
| 工具**前**的 thinking | 合并成 **一个** 思考折叠 |
| 工具**间**琐碎元思考（「让我再读…」） | **隐藏**（不新开行）；同族工具仍可跨过它合并 |
| 工具**后**可交付思考（含 `**加粗**` / 标题 / 结论口吻 / 足够长成段） | **升为 narrative**，插在工具簇之后，不当折叠埋掉 |
| 显式 `text` 块 | 一律 narrative |
| 同族 tool | 合成 `tool_cluster`；族切换或 narrative 打断才新开簇 |

可交付判定：`isDeliverableThinking`；琐碎判定：`isTrivialThinking`（见模型文件与单测）。

### 2.5 正文从哪来

穿插正文优先来自模型的 **`text` 块**。若模型只在 thinking 里写结论（常见带加粗），concise 用上述「可交付提升」露出；**不会**把整段 CoT 无差别铺开。

---

## 3. 模块分工

```
ProcessEntry[]  ──buildTurnPresentation(displayMode)──►  process / answerTexts
                         │
                         │  concise: text∈process, answerTexts=[]
                         ▼
              buildConciseTimeline(process)
                         │
                         ▼
              ConciseSegment[] ── ConciseTimelineView
                         │
          AssistantTurnView(concise) 无底部独立回答壳
          复制栏 = 全部 narrative 拼接
```

| 文件 | 职责 |
|------|------|
| `concise-timeline-model.ts` | 纯函数投影 + 分族 + 可交付/琐碎启发式 |
| `ConciseTimelineView.tsx` | 折叠行 + narrative `MessageResponse`/`useSmoothStream` |
| `AssistantTurnView.tsx` | concise → 时间线；full → ProcessGroup + 回答壳 |
| `session-turn-model.ts` | concise 拆分分支（W3） |
| `chat.css` | `.agent-concise-*` 弱灰摘要行样式 |

---

## 4. 验收

1. 连续多文件 Read/Edit → **一行**簇摘要，点开见明细  
2. 工具之间的模型结论（text 或可交付 thinking）→ 正文穿插，不进思考折叠  
3. 思考默认一行折叠；不用整轮秒数；不在每个 tool 前刷一行  
4. full 行为与现网一致  
5. `vitest`：`concise-timeline-model` + `turn-presentation` concise 路径绿  

```bash
npx vitest run \
  apps/electron/src/renderer/components/chat/concise-timeline-model.vitest.test.ts \
  apps/electron/src/renderer/components/chat/turn-presentation.vitest.test.ts
```

---

## 5. 明确不做

- 不改主进程 IR  
- 不做「Worked for Xm」总耗时大折叠（标题行计时已够）  
- 不把 full 的回答壳拆分改成 concise 那套  
- 不无差别把全部 thinking 当正文  

---

## 6. 相关文档

- 派工 brief（历史）：[CURSOR-CONCISE-brief.md](./CURSOR-CONCISE-brief.md)  
- 更早「轻量过程区」尝试：[CONCISE-UX-brief.md](./CONCISE-UX-brief.md)（已被本方案取代为展示模型，勿再走「只压行密度」）  
