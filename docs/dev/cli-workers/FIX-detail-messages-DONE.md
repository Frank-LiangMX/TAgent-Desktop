# FIX · CLI 详情消息 · DONE

## 改动

- `kscc-stream-observer.ts`：解析 tool_use 结构 + user/tool_result
- `run-kscc-worker.ts`：`onToolUse` / `onToolResult` / `onTextChunk` 转发
- `subagent-task-tool.ts`：CLI 路径 `emitPayload` 推带 `parentToolUseId` 的 sdk_message（工具过程 + final 正文）
- `pi-agent-adapter.ts`：`emitSubagentPayload` 同时服务 tagent_event 与 sdk_message

## 效果

外渠 + 本地 CLI 工人跑完后，详情页应看到工具行与最终报告文本，不再长期「尚未产生消息」。

## 测

`node node_modules/vitest/dist/cli.js run apps/electron/src/main/lib/agent/cli-workers`
