# Cursor 式简洁时间线

> 日期：2026-08-06（对齐 Cursor：灰字层级 + 深色进度文 + 子代理嵌套 + live 扫光）  
> 范围：仅 `displayMode === 'concise'`；`full` 零回归  
> 代码：`concise-timeline-model.ts` / `ConciseTimelineView.tsx`

---

## 1. 产品目标

```
[运行了 8m 6s]       ← 最外层（对齐 Cursor Worked for；时长 Xm Ys）
  ├ 思考了片刻 / 思考了 46s   ← 灰字折叠，可穿插整轮
  ├ 进度短文（深色内联）
  ├ 探索了 8 个文件，3 次搜索 ← 灰字阶段行（无勾选图标）
  │    • 子代理任务  模型名
  │      已完成
  ├ …
  └ 编辑了 N 个文件 +116 -32
[最终正文]            ← 容器外；折叠后主要只剩它
```

| 能力 | 行为 |
|------|------|
| 运行容器 | 最新一轮默认展开；用户发下一轮后历史链折叠 |
| 时长文案 | `运行了 8m 6s` / `思考了 46s` / `思考了片刻`（对齐 Cursor 后缀） |
| 过程链 | 思考折叠 + 进度短文 + 阶段灰字行，全部在容器内 |
| 思考折叠 | live 流式 body 钉底跟随（上滚暂停）；完成 settle ~1.8s 后 CSS 过渡折成「思考了 Ns / 片刻」，头栏常驻可点开回看全文 |
| 阶段块 | live：顶栏摘要只累积「探索了 N…」（完成态措辞、不扫光）；底下一行族级当前动作（探索中/编辑中…）可扫光；不自动展开步骤 |
| 子代理 | 挂探索/搜索阶段下：`• 任务` + 右侧模型 + 第二行状态 |
| live 扫光 | 运行中 / 思考中 / 阶段摘要 / 子代理进度 |
| 最终正文 | `narrative.final` 在容器外，无卡片边框 |
| 句尾状态 | 结束（完成/已中断/出错）统一在消息尾：`已中断 · 1m 24s · 03/15 14:32` |
| Files Changed | 有编辑工具时句尾卡片：`N Files Changed` + 文件名 + `+N -M`；Review/行点击 → 文件预览（非 git diff） |
| 句尾状态 | 完成 / 已中断 / 出错 · 耗时 · 墙钟；常显（非仅 hover） |
| full | ProcessGroupView 不变；句尾状态 / Files Changed 同上 |

---

## 2. 段类型

```ts
WorkStageStep =
  | { kind: 'thinking'; key; thinking }
  | { kind: 'tool'; key; tool; diff?: { add; del } }

ConciseSegment =
  | { kind: 'thinking'; … }           // 首轮工具前 + 中段「可交付」思考（打断阶段）；普通中段思考并入 work_stage.steps
  | { kind: 'work_stage'; steps; tools; summary; diffAdd?; diffDel? }
  | { kind: 'narrative'; text; tone: 'progress' | 'final' }
```

---

## 3. 验收

1. live 阶段：灰字摘要扫光 + 底部当前动作；完成后仍在，成折叠块（无常驻勾）  
2. 中段「可交付」思考升为独立「思考了 Ns」折叠，插在阶段之间；普通中段思考并入阶段 steps，不拆 stage、不刷独立折叠  
3. 子代理出现在探索阶段摘要下方  
4. 工具间 text = 进度短总结；尾部 = 最终正文。期望模型在每段思考后吐**一句**进度短文（点当前阶段、不展开）；无 text 时不编造、不补、不结尾复盘清单（见 §4）
5. vitest `concise-timeline-model` 绿  
6. **kscc one-shot final**：即使无 `stream_text_delta`、整段 `sdk_message` 一次落盘，concise 尾部正文仍走打字机（live progress 即逐字；升 final 不二次整坨闪现）；历史轮打开不重播打字机  
7. **live settle（对齐 Cursor 折进灰字摘要）**：工具完成不瞬间卸 DOM，先 hold 上一个动作扫光 ~500ms 再淡出 ~250ms；末阶段在回合 live 且其后无 narrative 时保持 live 底栏，整轮结束才收灰字行；`formatThinkingSummary` < 3s → `思考了片刻`（不刷「思考了 1s」）
8. **ThinkingFold 流式跟随 + settle 折进（对齐 Cursor Thought for Ns）**：live 思考在 fold body（max-height 220px）内流式时 `scrollTop` 钉底跟随最新字；用户上滚离开底部（距底 > 40px）则暂停跟随，回到底部恢复。仅过程队列末位的思考为 live（工具/正文一旦跟上 → idle），live→idle 不秒折 null 卸 body：先保持展开 ~1.8s settle，再以 CSS max-height/opacity 过渡折成「思考了 Ns / 片刻」灰字头；头栏常驻，点开可回看全文（内容常驻 DOM，整轮结束后仍在）；用户在 settle 期间手动收起则尊重取消
9. **多点 final 层级（对齐 Cursor 编号 + 标题另起 + 正文缩进）**：多条并列结论 / 对照 / 步骤须用 `1. 2. 3.` 有序列表；每条首行为加粗标题（`**标题**` 或 `**标题** → **一句结论**`），细则换行缩进子列表 `-`；禁止 `**标题**：` 后糊一整段正文。单点短答仍 1～3 句，不硬套编号。（与 `output-style-prompt.ts`「多点并列用有序编号」对齐。）

---

## 4. 明确不做

- 不改主进程 IR / 不强迫 kscc 必发 delta（渲染侧兜底 one-shot）  
- 无 text 时不编造进度文案  
- 完整文件 diff 面板（点击详情目前为 result 摘要截断）  
- 英文 UI 文案（保留中文，仅对齐 Cursor 视觉结构与时长格式）  
