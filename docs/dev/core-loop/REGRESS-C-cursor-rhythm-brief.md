# REGRESS-C Brief — Cursor 式节奏聚合 + live 扫光优雅折进

> 规格：`docs/dev/core-loop/CURSOR-CONCISE.md`  
> 计划：concise 对齐 Cursor（阶段聚合 + live settle）  
> 派工：本机 `kscc -p --dangerously-skip-permissions`（禁止 Cursor Task）

## 现象

对照 Cursor vs TAgent 执行链：

1. TAgent 满屏「思考了 1s」+「运行了 1 条命令」×N；Cursor 是短进度文 ↔ 一行「探索了 N…，运行了 K」。
2. TAgent live 扫光**闪现秒没**、执行链弹跳；Cursor 当前动作扫光，结束后**折进**阶段灰字摘要。

## 根因（已定位，直接修）

1. `concise-timeline-model.ts` ~516-528：凡非 trivial 中段思考都 `flushStage()` + 独立 ThinkingFold → 拆碎阶段。
2. `ConciseTimelineView.tsx` `WorkStageFold`：`stageLive = isLive && tools.some(!result)`；工具完成 liveStatus 立刻 `undefined` 且零延迟卸 DOM。
3. `formatThinkingSummary`：`durationSec>=1` 就「思考了 1s」，应对齐 briefly。

## 必改

### A. 模型（`buildConciseTimeline` thinking 分支）

- trivial → `continue`（保持）
- **已有工具且非 `isDeliverableThinking`** → `stageSteps.push({ kind:'thinking', ... })`，**不** flush、**不**推顶层 thinking segment
- **仅 `isDeliverableThinking`**（或工具前 leading）→ 现有 flush + 独立 ThinkingFold
- text/progress → 仍 flushStage（保持「总结 ↔ 阶段」）

### B. View（`WorkStageFold`）

1. Hold last live status ~400–600ms 再切/卸
2. live-status 淡出（opacity/height ~200–300ms），禁止瞬间 null 卸 DOM
3. 父回合 `isLive` 时，**最后一个 work_stage** 可保持 live 底栏（不只「有未完成 tool」）；整轮结束后收成灰字行
4. 只改 concise；full / ProcessGroupView 不动

### C. 文案

`formatThinkingSummary`：`durationSec` 缺省或 `< 3` → `思考了片刻`；`>= 3` → `思考了 Ns`。live 文案不变。

## 验收（必须自动化）

1. `tool → 中段普通思考 → tool → tool` → **一个** work_stage，summary 聚合；steps 含 thinking+tools
2. `tool → isDeliverableThinking → tool` → `work_stage | thinking | work_stage`
3. 现有 trivial / progress narrative / summarizeWorkStage 用例绿
4. `formatThinkingSummary(1)` → `思考了片刻`；`(46)` → `思考了 46s`
5. typecheck 相关包；concise 相关 vitest 绿

## 不做

- 不改 permission / REGRESS-A/B / 主进程 IR
- 不编造假进度文案
- 不 commit / push

## 交付

1. 可选短 findings：`docs/dev/core-loop/REGRESS-C-FINDINGS.md`
2. 改动文件 + vitest 摘要 + 手测步骤（stdout）
3. 可更新 `CURSOR-CONCISE.md` 补一条 live settle 验收
