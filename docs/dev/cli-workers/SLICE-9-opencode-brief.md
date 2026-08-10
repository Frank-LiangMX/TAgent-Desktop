# SLICE-9 opencode runner + observer（把 opencode 转正为可派工）

> 总监 brief。派 `kscc -p` 实现（建议 `--model glm-5.2 --permission-mode acceptEdits`）。**勿 git commit**。
> 前提：SLICE-8 已合入（opencode 已被启动探测扫进工人池，但 `supported:false`，设置页显示「已检测/暂不支持派工」）。
> 背景：用户机器装了 opencode 1.18.4（npm 全局 shim → `AppData\Roaming\npm\node_modules\opencode-ai\bin\opencode.exe`），
> 已实测真实入口为 `.exe`，可直接 spawn（不经 cmd，prompt 作 argv 末位安全）。本机暂 0 凭据，免费模型被限流，
> 故事件解析以 untether/opencode.jsonc 文档建模 + controller 测试为准，不依赖真实调用。

## 目标

1. 新增 `apps/electron/src/main/lib/agent/cli-workers/opencode-stream-observer.ts`（纯函数、无 IO，仿 mimo-stream-observer）：
   - 解析 opencode `run --format json` 的流式事件，顶层 `type`：`step_start` / `text` / `tool_use` / `step_finish` / `error`。
   - `text` 事件：`part` 是**纯字符串**（文本块，非逐字符对象）→ `textChunk` + 累进 summary。
   - `tool_use` 事件：
     - `part.tool` 映射到 UI 分类：`bash`/`shell` → `command`；`edit`/`write`/`multiedit` → `file`；`read`/`glob`/`grep` → `tool`；`websearch`/`webfetch` → `web_search`；`task` → `tool`。
     - `part.state.status`：`pending` → **整条忽略**（不计数、不 lastToolName、不 toolResult，避免进度闪烁）；`completed`/`failed`/`error` → 首次见该 callID 时 计数 + lastToolName + toolUse（id=`part.id`，缺省合成 `opencode-tool-N`；input=state.input 或 {}）；终态 → toolResult（content=state.output 字符串/对象 JSON 化，缺省 ''；failed/error → isError）。
     - 按 callID 去重（两段式 pending→completed 不重复计数）。
   - `step_start` / `step_finish` → 忽略（tokens/cost 不影响 ok/summary）。
   - `error` 事件：`{"type":"error","error":{"name":...,"data":{"message":...}}}` → 记录错误信息，`getError()` 返回 `name + message`（见下），**不混入** textChunk summary。
2. `run-ndjson-cli.ts` 最小扩展：`CliStreamObserver` 增加可选方法 `getError?(): string | undefined`；`runNdjsonCli` finalize 时在 abort/timeout 之后、exitCode 判断之前检查：`observer.getError?.()` 有值 → `ok:false`，summary 用该错误信息（带 label 前缀）。现有 observer 不实现该方法，行为不变。
3. 新增 `apps/electron/src/main/lib/agent/cli-workers/run-opencode-worker.ts`（仿 run-mimo-worker，经 runNdjsonCli）：
   - 命令：`{bin} run --format json --auto --dir <cwd> [--model <model>] <prompt>`，prompt 作 argv 末位。
   - **不加 `--share`**（默认即不分享；显式关掉分享语义）。
   - `-m <model>` 仅当 `worker.defaultModel` 非空；可空不强制。
   - Windows 由 `resolveCliBin` 解析：`.exe` → 直接 spawn（不经 shell，argv 安全）；`.cmd`（npm shim）→ `cmd.exe /c` + stdin 兜底（沿用现有逻辑，prompt 走 stdin 分支）。delivery 决策复用 `runNdjsonCli`（长/多行 prompt 走 stdin）。
   - 透传 signal / onProgress / onToolUse / onToolResult / onTextChunk。
4. `packages/shared/src/types/cli-workers.ts`：目录 opencode 置 `supported: true`（`SUPPORTED_CLI_WORKER_IDS` 自动含 opencode）；同步更新 opencode 条目注释（去掉「暂无 runner / SLICE-9 再补」字样）。
5. `apps/electron/src/main/lib/agent/cli-workers/run-cli-worker.ts`：`case 'opencode'` → `runOpencodeWorker(input)` + import。

## 边界（本切片不做）

- 不做 opencode 认证/凭据管理（用户需自行 `opencode auth login`；0 凭据 / 限流是外部状态，error 事件如实上报即可）。
- 不做多 step 会话恢复 / 续跑 / TUI 交互。
- 不做自定义工人 runner 插件机制。
- 不改其他 CLI（kscc/grok/codex/mimo）的 runner 与 observer。

## 验证

### 新测试

- `opencode-stream-observer.test.ts`（核心，用 untether 文档建模的 fixture）：
  - `step_start`（含 sessionID/title 字段）→ 忽略。
  - `text` 文本块 → textChunk + summary 累积（多块拼接）。
  - `tool_use` pending → 不触发 onProgress、不计数、无 toolResult。
  - `tool_use` completed（bash，state.output）→ toolUse + lastToolName=command + toolResult，计数 1。
  - `tool_use` failed → toolResult 带 isError。
  - 两段式同 callID（pending→completed）→ 只计 1 次，仅 completed 触发。
  - 工具名映射表全量断言（bash→command、edit→file、read→tool、websearch→web_search、task→tool）。
  - `error` 事件 → `getError()` 含 APIError/message；getSummary 不含错误文本。
  - 多次 step（step_start→...→step_finish ×2）→ 累计正确、不重计。
- `run-opencode-worker.test.ts`（mock spawn + resolveBinOnPath，仿 run-mimo-worker.test.ts）：
  - Windows .exe → 直接 spawn，args 含 `run`/`--format json`/`--auto`/`--dir cwd`，prompt 末位，**不含 `--share`**。
  - 传 defaultModel → args 含 `-m <model>`；不传 → 无 `-m`。
  - 非 Windows → 直跑 bin，prompt 末位。
  - abort → kill + ok:false。
- `run-cli-worker.test.ts`：补 mock `runOpencodeWorker`；`case 'opencode'` 路由透传；未知 id 断言补 `not.toHaveBeenCalled` for opencode；`SUPPORTED_CLI_WORKER_IDS` 断言改为 5 个 id。

### 既有测试更新（opencode 转正导致的语义变化）

- `packages/shared/src/types/cli-workers.test.ts`：
  - opencode `supported` 断言 true；`SUPPORTED_CLI_WORKER_IDS` 断言 `['kscc','grok','codex','mimo','opencode']`，length 5。
- `resolve-backend.test.ts` 中「SLICE-8 无 runner 工人过滤」一组（4 个用例）：opencode 已 supported，改用**用户自定义 id**（如 `custom-cli`，不在目录、bin 可用）来继续覆盖 unsupported 过滤语义；断言随之调整（全 unsupported → in-process；显式 preferred unsupported → warn 回落）。

### 回归

- `apps/electron` typecheck（`node .\node_modules\typescript\bin\tsc --noEmit`）+ 全量 `vitest run` 全绿（基线 116 文件 / 1369 用例）。
- 手动（可选）：本机 `opencode auth login` 后跑一次真实 `opencode run "ping" --format json --auto --dir .` 冒烟，确认事件流与 observer 假设一致；0 凭据时以 error 事件路径为准（ok:false、summary 含限流信息），不算失败。

## 不做 / 下一切片

- 自定义工人 runner 插件机制（用户自定义 id 的 runner 配置，未来）。
