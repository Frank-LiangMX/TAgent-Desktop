# REGRESS-B Brief — Cursor 式进度短总结 live 不显示、结束才出现

> 规格：`docs/dev/core-loop/REGRESS-2026-08-07-SPEC.md` §B  
> 派工：本机 `kscc -p --dangerously-skip-permissions`（禁止 Cursor Task）  
> 对照：`CURSOR-CONCISE.md`、`investigation/kscc-stream-flush/hypotheses.tsv`

## 现象

用户要对齐 Cursor：

```
思考块 → 落盘一句阶段性总结（progress）→ 阶段工作 → … → 最终正文
```

实际：**中间阶段性总结在流式过程中不显示**，非得整轮/会话结束后才出来。  
（与 H08「progress 一闪被 final 替换」可能同根或相邻——先取证再定。）

## 工作树已有未提交修复（先验收再决定是否补洞）

| 改动 | 意图 |
|------|------|
| `kscc-message-adapter.ts` 透传 `_partial` | H01/H05 |
| `session-service.ts` partial 不落盘 | H01/H05 |
| `session-turn-model.ts` partial 不抽空 streamingText | H08 |
| `useSmoothStream.ts` 子串兜底 | H06 |
| 配套 test 未跟踪文件 | 同上 |

## 必须回答（带行号）

1. live 时工具间 text / stream_text_delta 是否到达渲染层？卡在 adapter、落盘过滤、还是 presentation/timeline？
2. `buildTurnPresentation` + `buildConciseTimeline`：live 时 progress narrative 是否被算出来？算出来后 `ConciseTimelineView` 是否渲染？
3. 未提交的 `_partial` 修复是否足以让 progress **持续可见**（不只是不闪）？若否，缺口在哪一帧？
4. kscc 是否根本不发「段间 text」的 partial/delta，只在 final 一次给全文？（若是，渲染侧如何在 live 露出已到达的段间 text？）

## 修复目标

1. live 期间，已到达的段间 text 必须以 `narrative.progress` **持续可见**（打字机 OK）。
2. turn 结束后尾部升 final；历史打开不重播。
3. 补/改 vitest：模拟 `thinking → text(progress) → tool → text(progress) → …` 在 `isLive=true` 时 segments 含 progress。
4. 与 Agent A 分工：你不改 permission。

## 主要文件

- `packages/shared/src/utils/kscc-message-adapter.ts`
- `apps/electron/src/main/lib/ipc/session-service.ts`
- `apps/electron/src/renderer/components/chat/session-turn-model.ts`
- `apps/electron/src/renderer/components/chat/concise-timeline-model.ts`
- `apps/electron/src/renderer/components/chat/ConciseTimelineView.tsx`
- `packages/ui/src/hooks/useSmoothStream.ts`
- `apps/electron/src/main/lib/adapters/claude/claude-agent-adapter.ts`（partial 从哪来）

## 不做

- 不编造无 text 时的假进度文案
- 不改 Chat/Work 权限
- 不 commit / push

## 交付

1. 写 `docs/dev/core-loop/REGRESS-B-FINDINGS.md`
2. 最小修复（可完善未提交 diff）+ 单测绿
3. stdout：文件列表 + vitest 摘要 + 手测步骤
