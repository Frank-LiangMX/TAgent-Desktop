# SLICE-2 · kscc runner + 接入 task 工具

> 总监 brief。`kscc -p --model glm-5.2` 实现。  
> 依赖 SLICE-1 已完成（`listCliWorkersConfig` / `shouldUseCliWorker` / `resolveDefaultWorker`）。

## 目标

当配置 `enabled && defaultBackend==='cli'` 且默认工人 kscc 可用时：  
Pi `task` 工具 **spawn 本机 kscc** 执行 `params.prompt`，进度仍走 `onTaskEvent`，结果回 `tool_result`。  
否则 **完全走现有 in-process 路径**（零回归）。

## 目录

```
apps/electron/src/main/lib/agent/cli-workers/
  kscc-stream-observer.ts   # 解析 stream-json 行 → 进度 + 最终文本
  kscc-stream-observer.test.ts  # fixture 驱动
  run-kscc-worker.ts        # spawn + 读 stdout + abort
  resolve-backend.ts        # 读配置 → 'cli'|'in-process'
```

不要放到 pi-core（Electron spawn / 配置服务在主进程即可）。

## A. Observer（纯函数，先写测）

`feedLine(line: string, state): { state; progressToolName?: string; finalResult?: string }`

或 class：

```ts
class KsccStreamObserver {
  onLine(line: string): { lastToolName?: string }
  /** 结束后取摘要 */
  getSummary(): string  // 优先 type=result 的 result 字段，否则累积 assistant text
  getToolCallCount(): number
}
```

解析规则（对照 `docs/dev/cli-probe-2026-08-10/`）：

- JSON parse 失败 → 忽略该行  
- `type==='assistant'` 且 content 含 `tool_use` → progress lastToolName = name，计数 +1  
- `type==='assistant'` 且 content 含 `text` → 追加文本  
- `type==='result'` → `this.finalText = obj.result`（字符串）

单测 fixture：

- `docs/dev/cli-probe-2026-08-10/kscc-stream.stdout.txt` → summary `KSCC_STREAM_OK`  
- `docs/dev/cli-probe-2026-08-10/kscc-tool.stdout.txt` → 有 tool 次数、summary 含 `TOOL_DONE`

## B. runKsccWorker

```ts
export type RunKsccWorkerInput = {
  bin: string
  model?: string
  prompt: string
  cwd: string
  signal?: AbortSignal
  onProgress?: (lastToolName: string) => void
}

export type RunKsccWorkerResult = {
  ok: boolean
  summary: string
  toolCalls: number
  durationMs: number
  exitCode: number | null
}
```

命令（Windows 注意用现有 spawn 习惯，可参考 `spawn-kscc.ts` / `kscc-windows-spawn.ts`）：

```
{bin} -p --bare --dangerously-skip-permissions --output-format stream-json --verbose
  [--model {model}]
  {prompt}
```

- 逐行读 stdout → observer  
- abort → kill 子进程  
- exit !== 0 且无 summary → ok:false，summary 含 stderr 尾部  
- **不要**在测试里默认真 spawn；observer 单测足够。可选 `RUN_KSCC_LIVE=1` 才 live 测。

## C. resolve-backend

```ts
export function resolveTaskSubagentBackend():
  | { kind: 'in-process' }
  | { kind: 'cli'; worker: CliWorkerEntry }

// listCliWorkersConfig()
// if !shouldUseCliWorker(cfg) → in-process
// worker = resolveDefaultWorker(cfg); if !worker or worker.id !== 'kscc' → in-process
// 可选：which/probe bin 失败 → in-process + console.warn
```

probe 最小：`where`/`command -v` 或 `fs.existsSync` 绝对路径；失败回退 in-process。

## D. 改 subagent-task-tool.ts

在 `execute` 里，`task_started` **之后**：

```ts
const backend = resolveTaskSubagentBackend()
if (backend.kind === 'cli') {
  try {
    const r = await runKsccWorker({
      bin: backend.worker.bin,
      model: backend.worker.defaultModel,
      prompt: /* 见下 */,
      cwd,
      signal,
      onProgress: (name) => onTaskEvent?.({ type: 'task_progress', toolUseId, taskId, lastToolName: name }),
    })
    // task_notification + return tool_result（截断 12k 同现逻辑）
  } catch ...
  return
}
// 否则现有 new Agent(...) 路径不动
```

### 传给 kscc 的 prompt

把角色 system + 用户任务拼在一起，否则 CLI 没有 subagent_type 人格：

```ts
const fullPrompt = [
  def.prompt,  // 角色 system
  '',
  '## 任务',
  params.prompt,
].join('\n')
```

`taskType` 仍用 `subagentType`（入口卡）。  
description 逻辑不变。

### tool_result details

尽量保持 `TaskToolDetails` 字段：`subagentType, resultLength, toolCalls, durationMs`。

## 验收

- [ ] 配置默认：不 spawn，in-process 行为不变  
- [ ] 单测 observer fixture 绿  
- [ ] 手动（可选）：把 `~/.tagent-dev/cli-workers.json` 的 enabled=true, defaultBackend=cli，Pi 会话 task 应走 kscc  
- [ ] abort 能杀进程  
- [ ] 无 git commit  

## 禁止

- 设置 UI（SLICE-3）  
- grok/codex/mimo  
- 改双核主会话  

## 完成后

写 `docs/dev/cli-workers/SLICE-2-DONE.md`（文件列表、测命令、如何手动开 CLI）。
