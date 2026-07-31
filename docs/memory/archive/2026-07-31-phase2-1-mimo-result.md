# Phase 2.1 移植结果（mimo deepseek-v4-flash）

## 状态：完成 ✅（typecheck 通过）

## 移植的文件（源 `F:\TAgent_General\apps\electron\src\main\lib\` → 目标 `apps\electron\src\main\lib\memory\`）

| 文件 | 说明 |
|---|---|
| `memory-layer-service.ts` | 5 层记忆服务 + L4 SQLite。`getMemoryDir` 改为基于 `getConfigDir()`；`getDiscardedMemoryDir` 从 `./discarded-memory` re-export（未重复实现） |
| `nudge-service.ts` | Nudge 机制。路径改 `getMemoryDir`；`runLLMReview` 中 `nudge-llm-review` 调用 stub（Desktop 未移植该文件） |
| `memory-evidence-sink.ts` | 证据暂存层。路径改 `getMemoryDir` |
| `stage-queue-service.ts` | stage 三态门控队列。路径改 `getMemoryDir` |
| `memory-consolidation-service.ts` | 空闲批量整理核心。`defaultExecutor` stub 抛 `NOT_WIRED`；`buildDefaultDeps` 路径改 `getMemoryDir`，移除 electron 依赖 |
| `idle-memory-consolidation-scheduler.ts` | 空闲整理调度器。`agent-service`（前台活跃检测）stub 为保守 true |
| `reflect-service.ts` | Reflect 洞察提炼。`callLLM` stub 抛错 → 自动回退规则版关键词提取；移除 skill-curation 接力 |
| `scheduled-cleanup-service.ts` | 每周清理。路径改 `getMemoryDir`；移除 skill-curator 接力 |
| `self-repair-service.ts` | 月度自修复。路径改 `getMemoryDir` + `getConfigDir` |
| `agent-context-utils.ts` | 纯工具函数，无依赖，原样搬移 |
| `agent-session-compactor.ts` | 压缩工具。读写改用 `readSdkMessages`/`writeSdkMessages`（`../agent/session-store`）；`compactSession` 增加 `workspaceId?: string` 参数，不碰面板 messages.jsonl |
| `agent-prompt-builder.ts`（精简） | 只导出 `buildMemoryPromptSections`，`MEMORY_MANAGEMENT_RULES` 复用已有 `memory-management-rules.ts`，快照段参考 General L912-930 格式 |
| `index.ts` | re-export 全部公开服务与函数（七服务 + 工具 + 类型） |

测试文件未搬运（按 brief 允许）。

## 已知 TODO（2.2/2.3 接线）

1. **consolidation LLM**：`defaultExecutor`（memory-consolidation-service.ts）stub 抛 `ConsolidationError('NOT_WIRED')`。General 版依赖 `settings-service` / `channel-manager` / `proxy-fetch` / streamSSE，Desktop 未移植，需在 2.2 接 Desktop 的 `channel-store` + `@tagent/core`。
2. **Reflect LLM 提炼**：`callLLM`（reflect-service.ts）stub 抛错，运行时代码已自动回退规则版关键词提取，Reflect 不阻塞。
3. **Nudge 后台 LLM review**：`nudge-llm-review.ts` 未移植，`runLLMReview` stub（当前主流程走 evidence sink → 空闲 consolidation，不影响）。
4. **空闲调度前台检测**：`agent-service.hasActiveAgentSessions` 未移植，`isForegroundActive` 保守返回 true（空闲整理不会自动打扰，待 2.2 接真实检测或显式触发）。
5. **skill-curation / skill-curator 接力**：Desktop 无对应服务，reflect/cleanup 中的接力块已移除。

## 验证

```
cd F:\TAgent-Desktop\apps\electron && bun run typecheck
```

✅ 通过（tsc --noEmit，0 错误）
