# Phase 2.1 移植任务（给 mimo deepseek-v4-flash）

## 目标
从 `F:\TAgent_General\apps\electron\src\main\lib\` 移植全局记忆服务到
`F:\TAgent-Desktop\apps\electron\src\main\lib\memory\`。

## 已完成（不要动）
- `memory/discarded-memory.ts` — getDiscardedMemoryDir
- `memory/memory-management-rules.ts` — MEMORY_MANAGEMENT_RULES
- `memory/index.ts` — 入口 re-export
- claude-agent-adapter 已接 autoMemoryDirectory
- session-service kscc append 已拼 MEMORY_MANAGEMENT_RULES
- pi-agent-adapter createSession 已拼 MEMORY_MANAGEMENT_RULES
- Phase 1.2 JSONL 分离已完成：`appendSdkMessages` / `appendPanelMessages` / `readSdkMessages` / `readPanelMessages` / `writeSdkMessages`

## 必须移植的文件

| 源（General lib/） | 目标（Desktop memory/） |
|---|---|
| memory-layer-service.ts | memory-layer-service.ts |
| nudge-service.ts | nudge-service.ts |
| memory-evidence-sink.ts | memory-evidence-sink.ts |
| memory-consolidation-service.ts | memory-consolidation-service.ts |
| idle-memory-consolidation-scheduler.ts | idle-memory-consolidation-scheduler.ts |
| reflect-service.ts | reflect-service.ts |
| scheduled-cleanup-service.ts | scheduled-cleanup-service.ts |
| self-repair-service.ts | self-repair-service.ts |
| stage-queue-service.ts | stage-queue-service.ts |
| agent-context-utils.ts | agent-context-utils.ts |
| agent-session-compactor.ts | agent-session-compactor.ts |
| agent-prompt-builder.ts 中 MEMORY 相关导出 | agent-prompt-builder.ts（精简：只导出 buildMemoryPromptSections + MEMORY_MANAGEMENT_RULES 复用已有文件） |

可先不搬测试文件；若搬了需修路径。

## 强制适配点

1. **路径**：General 用 `app.getPath('home')/.tagent[-dev]`。Desktop 改用：
   ```ts
   import { getConfigDir } from '../config/config-paths'
   // getMemoryDir(mode) = mode==='general' ? join(getConfigDir(),'memory') : join(getConfigDir(),'ta','memory')
   ```
   不要用 `app.isPackaged` 拼 home；`getConfigDir()` 已处理 dev/packaged + TAGENT_CONFIG_DIR。

2. **getDiscardedMemoryDir**：已在 `discarded-memory.ts`，memory-layer-service 从该文件 re-export 或 import，不要重复实现。

3. **MEMORY_MANAGEMENT_RULES**：已在 `memory-management-rules.ts`，agent-prompt-builder 从该文件 import，不要复制字符串。

4. **agent-session-compactor**：读写改用
   ```ts
   import { readSdkMessages, writeSdkMessages } from '../agent/session-store'
   ```
   不要碰面板 messages.jsonl。compactSession 入参加 `workspaceId?: string`。

5. **import 路径**：General 相对路径改为 Desktop 结构；electron `app` 仅在确需时 import；better-sqlite3 已在 package.json。

6. **agent-prompt-builder 精简**：不要整文件 967 行搬过来（含大量 Desktop 没有的依赖）。新建精简版：
   ```ts
   export function buildMemoryPromptSections(opts: {
     mode: 'general' | 'ta'
     memorySnapshot: { l0?: string; l1?: string; l2?: string } | string | null | undefined
   }): { managementRules: string; memorySnapshotSection: string }
   ```
   managementRules 返回 MEMORY_MANAGEMENT_RULES；memorySnapshotSection 拼 `## 记忆快照`（参考 General L912-930）。

7. **index.ts**：re-export 所有公开服务与函数。

8. **不要**改 renderer / IPC / main index wiring（那是 2.2/2.3）。本任务只落 memory/ 服务文件 + 让 typecheck 过。

9. **consolidation LLM**：若 defaultExecutor 依赖 General 独有客户端，先 stub 或 TODO 注释，保证文件能编译；不阻塞 typecheck。

## 验证
```
cd F:\TAgent-Desktop\apps\electron && bun run typecheck
```
通过即可。

## 完成后
在 `.context/phase2-1-mimo-result.md` 写简短结果：移植了哪些文件、已知 TODO、typecheck 是否通过。
