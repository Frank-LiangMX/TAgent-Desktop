# Checkpoint 2 规格：当轮渲染契约 + 过程可见 + 输出克制

> 基线 commit：Checkpoint 1（`16eddc3` 一带）。本文件纠正 `00-SPEC.md` §3.2 的错误契约，并覆盖用户新反馈的六件事。
> 子代理据此实现，不得自行扩大范围。

## 0. 用户反馈 → 判定

| # | 用户说法 | 判定 | 处置 |
|---|----------|------|------|
| 1 | 思考中内容闪进正文再消失 | **成立**（闪的是 text，不是 thinking） | W5 必修 |
| 2 | 思考块要不要 Markdown | **要**（展开 MD，折叠纯文本预览） | W5 |
| 3 | 子代理过程不显示，只有结果 | **成立**（Pi 无过程事件 + 入口卡不画进度） | W6 |
| 4 | 好多次失败 | **多路径**；最常见是 Pi 气泡 `[请求失败]`，不一定有 Banner | W7 先观测，不盲改 |
| 5 | Proma 当轮思考在正文、闭合才进运行块？ | **猜错了**；思考始终在过程区。自动折叠猜对了 | W5 |
| 6 | Agent 废话特别多 | **成立**（主会话无沟通红线 + 富内容鼓励堆砌） | W8 |

四路调查：

- [子代理过程](b452e45d-aa58-439c-9d48-a4a79659f0d1)
- [运行失败](32e36a68-a5c8-4a45-b9af-4291634cbb16)
- [当轮渲染](74662bae-dc2b-46c6-8274-fd09bf28969c)
- [废话根因](7cc9e832-a312-45d2-845a-15b1ba37e039)

## 1. 纠正 Checkpoint 1 的错误

`00-SPEC.md` §3.2「尾部正文一律进回答、与 live 无关」是**矫枉过正**，直接放大了闪现：

```
thinking + text 流式 → hasOpenTools=false → 提前外置回答区
→ 随后 tool_use → 文本跳回过程区（80 字灰字）→ 回答区空
```

正确契约对齐 Proma/General 的 `buildAssistantTurnRenderItems`：

> **仅当**尾部 text 之前存在 tool_use，**且**这些工具全部已有 result 时，才把尾部 text 外置到回答区。
> streaming / live 且工具未齐（含「还没有任何工具、只有 thinking+text」）→ **整轮留在过程组**。

同步修正 `00-SPEC.md` §3.2 与验收项 3。

## 2. 目标模型（W5）

### 2.1 拆分规则

`session-turn-model.ts` → `buildTurnPresentation`：

```
canSplitFinalOutput =
  trailingTextStart > 0
  && toolsBeforeTrailing.length > 0
  && toolsBeforeTrailing.every(hasResult)
  && !hasOpenToolsAfterTrailing   // 尾部之后不能再有未闭合工具

若 canSplit → 尾部 text → answerTexts；其余 → process
否则 → 整轮进 process（含 streamingText / streamingThinking）
纯 text、无过程块 → 直接回答区
```

### 2.2 回答区喂流

`AssistantTurnView`：live 且 `!canSplit` 时，**禁止**用 `streamingText` 填回答壳。回答区只吃稳定交付 text。

### 2.3 过程区

`ProcessGroupView`：

1. **结束后自动折叠**：live→idle 后约 3s 倒计时收起；用户手动 toggle 则取消自动折（抄 Proma/General）。
2. **holdOpen 收窄**：live 期间只强制展开「当前正在写的思考段」，不是所有历史思考段。
3. **思考渲染**：展开用 Markdown（`MessageResponse`）；折叠用纯文本预览。
4. **过程内 text**：去掉「只能 80 字」作为唯一展示；中间文完整可读（可用弱样式）。

### 2.4 thinking 永不进回答区

段闭合只改变折叠态，不做跨区 DOM 迁移。

## 3. 子代理过程可见（W6）— 最小可用优先

目标感知：「叫起来能看到在干什么」，不是一步到位嵌套 General 级时间线。

### 3.1 Pi 必做（否则下游无源）

`subagent-task-tool.ts`：子 Agent `subscribe` 时向外推：

- `task_started`
- `task_progress`（至少带 `lastToolName` / 简短 `progressText`）
- `task_notification`（完成/失败）

接到父 adapter → session-service `sendPayload`。

### 3.2 入口卡画进度

`SubagentEntryCard` 展示已有状态机字段：`progressText` / `lastToolName` / `summary`（`reduceTaskEvent` 已就绪，UI 没画；`TaskCardView` 是死代码可复用逻辑）。

### 3.3 本轮不做（列入后续）

- 带 `parentToolUseId` 的 token 级流式进详情页
- 主时间线嵌套子 `tool_use`（对齐 General 的产品选择，另开规格）

## 4. 失败（W7）— 先观测，不盲改核

「好多次失败」不是单一 bug。本轮只做可观测性，不改 Pi 重试核：

1. Chat 对 `result` 的 `error_*` / `errors[]`：**至少**把用户可见错误抬到 `SessionErrorBanner` 或回合末错误条（现在几乎透明）。
2. 文档写清：用户复现时优先看 Banner「复制错误」/ 气泡 `[请求失败]` / 主进程终端。
3. **不**在本轮重写 `pi-agent-adapter` 重试逻辑——缺错误原文时改核是赌博。

若用户下次贴出具体错误原文，再开 W7b 定点修。

## 5. 输出克制（W8）

### 5.1 主会话加沟通红线（双核同文）

新增 `buildOutputStylePrompt()`，kscc（`session-service.ts` append）与 Pi（`DEFAULT_SYSTEM_PROMPT` 或公共 append）共用：

```markdown
## 输出风格（对用户可见回复）

- 默认短答：先给结论或可执行下一步，再按需补最小必要细节。
- 禁止：客套开场、复述用户原话、逐步旁白工具过程、结束后再写「总结一下我做了什么」长清单。
- 工具过程只在对排障有用时用一两句带过；改动用路径/关键 diff 说明。
- 不要为显得全面而堆 Markdown 清单、表格、mermaid、datatable；仅当用户明确要求，或对比/结构本身就是交付物时才用。
- 简单是/否、单点修复、单文件小改：通常不超过一小段。
```

### 5.2 收紧富内容

`buildRichContentSystemPrompt`：加「按需非默认」门槛；弱化「优先用 datatable」。

### 5.3 本轮不做

- 整段接入 `BUILTIN_DEFAULT_PROMPT`
- 改角色库全量沟通风格
- 动 `maxTurns` / 未接线的 `reasoningEffort`

## 6. 验收标准

### W5（必须有单测）

1. streaming + thinking + trailing text、尚无 tool → **整组 process**，回答区空。
2. tool_use 出现且未齐 → 仍整组 process；回答区不闪。
3. 前置工具全部有 result + 尾部 text → text 进 `answerTexts`。
4. 纯 text 无过程块 → 直接回答区。
5. live→idle 后过程组进入自动折叠倒计时（可用假时钟或状态断言）。
6. 思考展开态走 Markdown 组件路径（冒烟/浅测即可）。

### W6

7. Pi 子代理运行中，入口卡能显示非空 `lastToolName` 或 `progressText`（单测 `reduceTaskEvent` + 卡渲染，或 adapter 级事件断言）。

### W7

8. 带 `resultSubtype: error_*` 的 result 到达时，用户可见错误条出现（单测 Chat 归约或错误 atom）。

### W8

9. `buildOutputStylePrompt` 被 kscc/Pi 注入路径引用；富内容文案含「按需」门槛（快照/字符串断言）。

### 工程

- `bun run typecheck` 全绿
- 相关 vitest 全绿
- 每个工作流单独 commit；最后修正 `00-SPEC.md` §3.2

## 7. 工作流与 commit 顺序

| 编号 | 范围 | 主要文件 | 风险 |
|------|------|----------|------|
| W5a | 拆分契约纠正 + 单测改写 | `session-turn-model.ts`、`turn-presentation.vitest.test.ts`、`AssistantTurnView.tsx` | 中：直接消闪 |
| W5b | 自动折叠 + 思考 MD + 过程内 text | `ProcessGroupView.tsx` + 样式 | 中 |
| W6 | Pi task_* 进度 + 入口卡展示 | `subagent-task-tool.ts`、adapter 推送、`SubagentEntryCard.tsx` | 中 |
| W7 | result 错误可见 | `Chat.tsx`、error atoms、可选 `kscc-message-adapter` | 低 |
| W8 | 输出风格 + 富内容收紧 | 新 prompt helper、`session-service.ts`、`pi-agent-adapter.ts`、`rich-output-validate.ts` | 低 |
| W5c | 修正 `00-SPEC.md` §3.2 | 文档 | 无 |

实施原则：先 W5a（消闪），再 W5b / W8（体验与文风，可并行），再 W6，最后 W7。缺错误原文前不改 Pi 重试核。
