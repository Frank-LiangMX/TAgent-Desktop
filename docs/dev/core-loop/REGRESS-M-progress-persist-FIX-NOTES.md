# REGRESS-M — 段间 progress 总结「打完秒消」

> 日期：2026-08-07  
> 用户截图：`运行了 1 条命令` 之间的灰字总结（「还有更多未跟踪…」「52 个文件已暂存…」）流式出现后消失。

## 根因（落盘定性）

截图文案在 `session-1786088306947.messages.jsonl` 均为 **`type: text`**（L290/L302…），**不是** `thinking`。用户说的「阶段性思考总结」= concise 段间 progress 旁白。

`Chat.tsx` `tool_start` 直接 `streamState.text = ''`。concise 下这段总结常**只活在** `streamState`（`holdStreamInProcess` → NarrativeRow 打字机），工具一开始缓冲被清、items 尚未带 text → **秒消**；等 sdk_message text 才可能回来。

## 修法

`tool_start` 清缓冲前：`commitStreamTextToLastAssistant` 把 pending text 插到末条主线 assistant 的第一个 `tool_use` 之前，再清 `streamState.text`（对齐思考的 commit 模式）。

## 文件

- `stream-item-model.ts` + vitest  
- `Chat.tsx` tool_start 分支
