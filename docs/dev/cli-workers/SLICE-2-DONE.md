# SLICE-2 · DONE（kscc runner + 接入 task 工具）

- **改了哪些文件**：
  - 新增 `apps/electron/src/main/lib/agent/cli-workers/kscc-stream-observer.ts`（`KsccStreamObserver` 纯函数类：`onLine` 解析 stream-json 行 → tool_use 计数+lastToolName / text 累积 / result 收口；`getSummary` 优先 result 否则累积 text；`getToolCallCount`）+ `kscc-stream-observer.test.ts`（fixture 驱动 + 解析规则，10 例）。
  - 新增 `apps/electron/src/main/lib/agent/cli-workers/run-kscc-worker.ts`（`runKsccWorker`：spawn `kscc -p --bare --dangerously-skip-permissions --output-format stream-json --verbose [--model] <prompt>`，逐行喂 observer，onProgress 转发 tool_use，abort→`child.kill()`，exit≠0 且无 summary→ok:false 含 stderr 尾；Windows spawn 习惯参考 spawn-kscc/kscc-windows-spawn：bare 名走 `cmd.exe /c`、绝对 .cmd 走 `planKsccWindowsSpawn` 直连 node）+ `run-kscc-worker.test.ts`（mock spawn 不起真进程，9 例：exit0/result、exit≠0/stderr、onProgress、abort→kill、已 abort 不 spawn、spawn 抛错、child error、model argv）。
  - 新增 `apps/electron/src/main/lib/agent/cli-workers/resolve-backend.ts`（`resolveTaskSubagentBackend()`：读 `listCliWorkersConfig`→`shouldUseCliWorker`→`resolveDefaultWorker`→worker.id 必须为 `kscc`→probe bin（绝对路径 existsSync，bare 名信任 PATH），任一不满足回退 in-process）+ `resolve-backend.test.ts`（7 例：disabled/默认非 kscc/绝对 bin 不存在/exist/工人禁用/defaultBackend=in-process 各分支）。
  - 改 `apps/electron/src/main/lib/adapters/pi/subagent-task-tool.ts`：import 两个新模块；在 `execute` 的 `task_started` 之后插入 `resolveTaskSubagentBackend()` 分支——`cli` 分支拼 `fullPrompt = [def.prompt, '', '## 任务', params.prompt].join('\n')`，调 `runKsccWorker`，进度转 `task_progress`，终态 `task_notification`，`tool_result` 截断 12k、`details` 保留 `subagentType/resultLength/toolCalls/durationMs`，catch 不抛回 `tool_result`；`in-process` 分支不动（零回归）。
- **如何跑测**：
  - 本 slice 三件套：`node node_modules/vitest/dist/cli.js run apps/electron/src/main/lib/agent/cli-workers/kscc-stream-observer.test.ts apps/electron/src/main/lib/agent/cli-workers/run-kscc-worker.test.ts apps/electron/src/main/lib/agent/cli-workers/resolve-backend.test.ts` → 26 passed。
  - 合并 SLICE-1（含 service + shared 类型）：再加 `apps/electron/src/main/lib/agent/cli-workers-service.test.ts packages/shared/src/types/cli-workers.test.ts` → 62 passed。
  - 回归：`apps/electron/src/main/lib/adapters/pi/pi-agent-adapter.event-ir.test.ts` + `apps/electron/src/main/lib/agent/subagent-definitions.test.ts` → 30 passed（未触现有 in-process 路径）。
  - typecheck：`node node_modules/.bun/typescript@5.9.3/node_modules/typescript/bin/tsc --noEmit -p apps/electron/tsconfig.json` 仅余 SLICE-1 既有 3 处 WIP 报错（`Chat.tsx` modelId/fallbackModelId、`SessionSidebar.tsx` onClick，非本 slice 引入），本 slice 新增文件 0 报错。
- **如何手动开 CLI**（验收「手动（可选）」）：编辑 `~/.tagent-dev/cli-workers.json`（首次访问由 SLICE-1 自动 seed），改为
  ```json
  {
    "version": 1, "enabled": true, "defaultBackend": "cli", "defaultCliId": "kscc",
    "workers": [{ "id": "kscc", "enabled": true, "bin": "kscc", "defaultModel": "glm-5.2" }]
  }
  ```
  （`bin` 也可填 kscc.cmd 绝对路径，Windows 上绝对 .cmd 会走 `planKsccWindowsSpawn` 直连 node 绕开 PATH 缺 node）。重启会话后 Pi 主 Agent 调 `task` 工具会 spawn 本机 kscc 执行；日志可见 `[子代理 <sid>] <type> (kscc) 完成: ok=true, N 次工具调用, <ms>ms, exit=0`，入口卡进度走 `task_progress.lastToolName`。未开（默认 `enabled:false`）则完全走原 in-process `new Agent(...)` 路径，零行为变化。
- **abort 验证**：`runKscc-worker.test.ts` 的 `abort → kill 子进程` 用例 mock 验证 `child.kill()` 被调用且 `ok:false`；真机中止 task 时 Pi 传入的 `AbortSignal` 触发同一 `onAbort`→`child.kill()`。
- **遗留 / 后续**：(1) 设置 UI（SLICE-3）未做，现需手改 `cli-workers.json` 开启；(2) `probeBin` 对 bare 名（如 `kscc`）信任 PATH 不做 `where` 探测，交 `runKsccWorker` 失败兜底（避免每次 task 调用同步起进程）；(3) prompt 走 argv 位置参数，超长（cmd.exe ~8KB）未切 `--prompt-file`（FINDINGS 建议，后续 slice）；(4) Windows `cmd.exe /c kscc` 被 kill 时仅杀 cmd、未强制杀孙进程 node（已知 Windows 限制，后续可接 taskkill /T）；(5) grok/codex/mimo 未接（brief 禁止）；(6) 未 git commit（按要求）。
