# REGRESS-K1 FIX NOTES — 思考行永驻执行块

> 日期：2026-08-07  
> 规格：`REGRESS-K1-persist-thinking-SPEC.md`

## 改动

| 文件 | 改什么 |
|------|--------|
| `ProcessGroupView.tsx` | idle 收起时仍渲染思考头；**展开时按过程顺序交错**（不把思考全置顶） |
| `process-group-model.ts` | 保留 `splitProcessForRender` 工具（可测拆分）；视图层以交错为准 |
| `chat.css` | `.agent-process-group__thinking` |
| `concise-timeline-model.ts` | idle 不再丢 trivial / 非 deliverable 思考 |
| `ConciseTimelineView.tsx` | 阶段收起时 peek 思考 step 头 |
| `concise-timeline-model.vitest.test.ts` | 对齐 K1 |
| `process-group-model.vitest.test.ts` | `splitProcessForRender` 单测（验收#1：full 折叠后仍暴露 thinking） |

## 验收（单测）

- **full 折叠后仍暴露 thinking 条目**：`process-group-model.vitest.test.ts` 的 `splitProcessForRender` 用例——思考拆出 body，body 卸载不带走思考行（concise 投影合并成单块）。组件层 `ProcessGroupView` 收起态常驻渲染思考头、展开态按过程序交错。
- **concise idle trivial 思考仍进 timeline**：`concise-timeline-model.vitest.test.ts`——trivial / 非 deliverable 思考 idle 不再丢弃（并入 stage.steps，展开可见）；跨阶段思考升独立 fold。阶段收起态 peek 思考 step 头（`ConciseTimelineView`）。
- 跑通：`vitest run`（两文件）66 passed；`tsc --noEmit -p apps/electron/tsconfig.json` 0 error。

## 手测

1. **full**：思考+工具 → 结束后过程可收起，**仍见「思考了…」**，点开有全文；「查看过程」打开工具/过程正文。
2. **concise**：阶段收起仍见思考 step；展开可见全文。
3. 热更/重启后再跑一轮。

## 说明

过程区里**分析性 text**（`ProcessTextRow`）仍可能随「查看过程」收起——那是段间正文，不是 thinking 块。若仍把那段误认成思考，点开「查看过程」应能找回。
