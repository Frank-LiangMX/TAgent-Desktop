# SLICE-10 Claude Code runner + observer（把 claude 转正为可派工）

> 总监亲做 brief；本片不派 kscc（用户明确要求本人实现）。**勿 git commit/push**（用户逐次确认）。
>
> 前提：SLICE-9 已合入（opencode 转正，`runNdjsonCli` 已带 `getError()` 流内错误语义）。
> 背景：Claude Code 与 kscc 同源（kscc 是定制版 Claude Code），`-p --bare --dangerously-skip-permissions
> --output-format stream-json --verbose` 启动，事件为 assistant / user / result 体系。
> 本机未装 claude（与当初 opencode 情况一致）：先加目录 + runner，装了自动可用；fixture 按
> Claude Code stream-json 文档建模 + mock-spawn controller 测试，不依赖真实调用。

## 目标

1. 新增 `apps/electron/src/main/lib/agent/cli-workers/claude-stream-observer.ts`（纯函数、无 IO，仿 kscc observer）：
   - 解析 Claude Code stream-json：`system`（init）→ 忽略；`assistant.message.content` 里
     `text` 块 → textChunk + 累积 summary，`tool_use` → 计数 + lastToolName + toolUse；
     `user.message.content` 里 `tool_result` → toolResult（匹配 tool_use_id，is_error 透传）。
   - 工具名映射（大小写不敏感，兼容 kscc 变体）：Bash/Shell → command；Edit/Write/MultiEdit → file；
     Read/Glob/Grep → tool；WebSearch/WebFetch → web_search；Task → tool；未列出者原样透传。
   - `result` 事件：`result` 字符串 → 终态摘要（优先于 textChunks）；`is_error:true`（社区实证
     subtype="success" 时 is_error 也可能为 true，以 is_error 为准）或 subtype 以 error 开头
     → `getError()`，errors[] 字符串/对象消息拼接，无消息时兜底文案带 subtype。
   - 实现 `CliStreamObserver`（onLine / getSummary / getToolCallCount / getError）。
2. 新增 `apps/electron/src/main/lib/agent/cli-workers/run-claude-worker.ts`（仿 run-opencode-worker，经 runNdjsonCli）：
   - 命令：`{bin} -p --bare --dangerously-skip-permissions --output-format stream-json --verbose
     [--model {model}] <prompt>`；`-p` 无位置 prompt 时从 stdin 读（stdin 投递形态同 codex/kscc）。
   - `--model <model>` 仅当 `worker.defaultModel` 非空。
   - Windows 用 `resolveCliBin`：`.exe` → 直 spawn（argv 安全）；`.cmd`/bare → cmd.exe /c + stdin 兜底；
     长/多行 prompt 一律 stdin（复用 `isLongOrMultiline`）。
   - 透传 signal / onProgress / onToolUse / onToolResult / onTextChunk。
3. `packages/shared/src/types/cli-workers.ts`：目录追加
   `{ id: 'claude', bins: ['claude'], supported: true, capability: { cost: 4, reasoning: 'high', goodFor: '长任务 / 深改造 / 重构' } }`
   （`SUPPORTED_CLI_WORKER_IDS` 自动含 claude）。不改 seed（opencode 同例：经启动探测合并，不预置）。
4. `run-cli-worker.ts`：`case 'claude'` → `runClaudeWorker(input)` + import + 头部注释。

## 边界（本片不做）

- 不做 Claude 认证/订阅管理（用户需自行 `claude` 登录；0 凭据/限流时 result is_error:true
  如实上报 ok:false，summary 含错误信息）。
- 不做会话 resume / TUI 交互 / `--permission-mode` 之外的权限细粒度（子代理无 TTY，
  与 kscc/mimo 一致走 `--dangerously-skip-permissions`；如需收敛权限属独立产品决策）。
- 不做自定义工人 runner 插件机制（沿用「每个 CLI 一个小适配层 + 共享 runNdjsonCli 基础」，
  插件机制仍为未来项）。
- 不改其他 CLI（kscc/grok/codex/mimo/opencode）的 runner 与 observer。

## 验证

### 新测试

- `claude-stream-observer.test.ts`（核心，fixture 按 Claude Code stream-json 文档建模）：
  - system init → 忽略；非 JSON/空行 → {}。
  - assistant text 块 → textChunk + summary 累积；单条 content 同时 text+tool_use 各就其位。
  - tool_result 匹配 tool_use_id、content 字符串/文本块数组、is_error 透传、缺 id 忽略。
  - 工具名映射表全量断言（大写 Claude 风格 + 小写变体 + 未列出透传）。
  - result success → summary=result 字符串；is_error:true（subtype="success" 怪例）→ getError()
    且 summary 不混入；subtype 以 error 开头 → getError() 兜底；errors[] 字符串拼接。
- `run-claude-worker.test.ts`（mock spawn + resolveBinOnPath，仿 run-opencode-worker.test.ts）：
  - Windows .exe → 直 spawn，flags 齐全（-p/--bare/--dangerously-skip-permissions/
    --output-format stream-json/--verbose），prompt 末位，不走 stdin。
  - 传 defaultModel → --model <model>；不传 → 无 --model。
  - 多行 prompt → stdin；非 Windows → 直跑 bin、prompt 末位。
  - assistant tool_use + text + user tool_result + result → 回调解发 + summary。
  - abort → kill + ok:false；result is_error:true → ok:false 且 summary 含错误信息。
- `run-cli-worker.test.ts`：补 mock runClaudeWorker；`case 'claude'` 路由透传；
  未知 id 断言补 not.toHaveBeenCalled；SUPPORTED 6 个 id。

### 既有测试更新（claude 转正导致的语义变化）

- `packages/shared/src/types/cli-workers.test.ts`：目录顺序断言加 'claude'；supported 断言加
  byId('claude')；SUPPORTED 列表 `['kscc','grok','codex','mimo','opencode','claude']`，length 6。

### 回归

- `apps/electron` typecheck（`node .\node_modules\typescript\bin\tsc --noEmit`）。
- 根目录全量 `vitest run` 全绿（基线 118 文件 / 1395 用例 → 预计 120+ / 1420+）。
- 手动（可选）：本机装 claude 并登录后跑一次真实 `claude -p "ping" --output-format stream-json
  --verbose` 冒烟，确认事件流与 observer 假设一致；0 凭据时以 result is_error 路径为准。

## 不做 / 下一切片

- 自定义工人 runner 插件机制（用户自定义 id 可插桩第三方 CLI，免改主分支代码；持续挂起）。
