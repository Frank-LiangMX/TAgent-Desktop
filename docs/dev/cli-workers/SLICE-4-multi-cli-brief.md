# SLICE-4 · 多 CLI 工人（codex / grok / mimo）

> 总监 brief。`kscc -p --model glm-5.2` 实现。勿 git commit。  
> 前提：SLICE-1～3 + prompt 投递 + 详情消息 + 历史回填已通；kscc 路径已验证。

## 目标

设置里可选 **默认 CLI 工人**（kscc / codex / grok / mimo），`task` 按 `defaultCliId` 路由；  
每种 CLI 用 **独立薄 runner + observer**，复用详情 `emitPayload` / 寒暄检测思路。

## 边界

- **仍只做 L1 短命工人**，不做主核  
- **仍排除** hermes / openclaw（deny-list 已有）  
- 不接 ACP  
- 设置 UI：默认 CLI 下拉 + 各工人 enable/bin/model（可编辑 seed 四条）

## 探测结论（已有样本）

见 `docs/dev/cli-probe-2026-08-10/FINDINGS.md`：

| id | 命令 | 结构化输出 |
|----|------|------------|
| kscc | 已实现 | stream-json |
| grok | `grok -p … --always-approve --output-format streaming-json` | thought/text/tool_call/end |
| codex | `codex exec --skip-git-repo-check --ephemeral -s read-only --json …` | thread/turn/item.* |
| mimo | `mimo run --dangerously-skip-permissions --format json …` | step_*/text/tool_use |

## 实现

### 1. 配置 seed 扩为 4 工人

`packages/shared/src/types/cli-workers.ts`：

```ts
workers: [
  { id: 'kscc', enabled: true, bin: 'kscc', defaultModel: 'glm-5.2' },
  { id: 'grok', enabled: true, bin: 'grok', defaultModel: undefined },
  { id: 'codex', enabled: true, bin: 'codex', defaultModel: undefined },
  { id: 'mimo', enabled: true, bin: 'mimo', defaultModel: undefined },
]
```

- `defaultCliId` 默认仍 `kscc`  
- 校验：id 白名单 `kscc|grok|codex|mimo`（或任意非 deny 的 id）；**去掉「只能 kscc」**  
- 旧配置仅 1 条 kscc：list 时 merge 补齐缺的三条（不覆盖用户已有字段）

### 2. resolve-backend

- 删除 `worker.id !== 'kscc'` 硬限制  
- `probeBin` 对 bare 名仍信任 PATH  

### 3. 统一入口 `run-cli-worker.ts`

```ts
export async function runCliWorker(input: {
  worker: CliWorkerEntry
  prompt: string
  cwd: string
  signal?: AbortSignal
  onProgress? / onToolUse? / onToolResult? / onTextChunk?
}): Promise<RunKsccWorkerResult> // 或改名 RunCliWorkerResult
```

- `switch (worker.id)` → `runKsccWorker` | `runGrokWorker` | `runCodexWorker` | `runMimoWorker`  
- 未知 id → ok:false 中文 summary  

### 4. 三个新 runner（对齐 run-kscc-worker 结构）

各文件：`run-grok-worker.ts` / `run-codex-worker.ts` / `run-mimo-worker.ts`  
+ 各自 observer + fixture 单测（用 `docs/dev/cli-probe-2026-08-10/*-stdout.txt`）

要点：

| | spawn 要点 | 解析要点 |
|--|------------|----------|
| **grok** | 优先 `grok -p` + `--always-approve` + `streaming-json`；长 prompt → `--prompt-file` 临时文件（grok 原生支持） | type: text/thought/tool_call/tool_call_update/end |
| **codex** | `codex exec --skip-git-repo-check --ephemeral -s read-only --json -C cwd prompt`；Windows 勿 cmd 拆 prompt（argv 数组或 stdin） | item.completed agent_message / command_execution；turn.completed |
| **mimo** | `mimo run --dangerously-skip-permissions --format json --dir cwd …` | step_start/text/tool_use/step_finish；tool_use 可能一条 completed |

寒暄软失败：kscc 已有；其它 CLI 可共用宽松检测或仅 kscc。

### 5. subagent-task-tool

- `runKsccWorker` → `runCliWorker({ worker: backend.worker, … })`  
- modelId：`worker.defaultModel || worker.id`  
- 详情 emit 逻辑不变  

### 6. 设置 UI `CliWorkersSettingsSection`

- 「默认 CLI」下拉：workers 里 enabled 的 id  
- 列表展示 4 行：enable / bin / model（与现 kscc 行同构，map workers）  
- 保存整表  

## 验收

- [ ] 默认仍可只开 kscc；选 codex/grok/mimo 时 resolve 不再被拒  
- [ ] 各 observer fixture 单测绿  
- [ ] typecheck 本 slice 0 新增错  
- [ ] `docs/dev/cli-workers/SLICE-4-DONE.md`  
- [ ] 不 git commit  

## 禁止

- hermes/openclaw  
- 主核深度适配  
- 大改 Chat  
