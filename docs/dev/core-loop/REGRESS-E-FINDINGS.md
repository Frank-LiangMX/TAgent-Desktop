# REGRESS-E FINDINGS — 思考结束后时间线消失

> 日期：2026-08-07  
> 用户截图：整轮后只有「运行了 N 条命令」，无任何「思考了 Ns」

## 根因（已坐实）

1. **H1**：`sdkMessageToIR` 只读 `m._partial`，kscc/SDK **从不打标**；且 **不透传 `stop_reason`** → 渲染层无法区分 partial/final。
2. **H2**：`shouldClearStreamThinking` 仅凭 `stop_reason` 就清 stream（即便 content 无 thinking）。
3. **H3（致命）**：同 uuid upsert **整表替换** content；后到 tool-only 快照剥掉 thinking → **最后一段思考也没了**。
4. **H4**：`Chat.tsx` 在 `tool_start` 上 **整表 `resetStreamState()`** → 工具一开始就把仍在缓冲的思考清掉（闪没主因）。
5. **H5**：`turn_end` / `result` 清 stream 前未把缓冲思考写入 items。

REGRESS-D settle 只改折叠动画，救不了 segment 被删。

## 已修

| 改动 | 文件 |
|------|------|
| 无 stop_reason ⇒ `_partial:true`；透传 stop_reason | `kscc-message-adapter.ts` |
| 仅 content 有 thinking 才清 stream | `shouldClearStreamThinking` |
| upsert 保留已有 thinking 块 | `preserveAssistantThinking` |
| tool_start 只清 text，保留 thinking | `Chat.tsx` |
| turn_end/result 先 `commitStreamThinkingToLastAssistant` 再清 | `Chat.tsx` + `stream-item-model.ts` |

## 手测

concise：长思考 → 工具 → 结束。时间线须留下可点开的「思考了 Ns/片刻」，不能只剩「运行了 N 条命令」。
