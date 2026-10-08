# 官方内核停止与续聊验收

日期：2026-09-17。承接 [真实 API 验收](official-api-live-acceptance-2026-09-17.md)。本页区分测试误报、产品修复与仍未覆盖项。

## 查明的原因

### 测试环境误报：Bun 的 HTTP 关闭事件

最小对照：普通 Node 子进程请求本地 SSE 后取消并退出。Node HTTP 服务观察到 response/socket `close`；Bun 的 `node:http` 兼容层未观察到同样事件。使用 Bun 当取消观察端，会把已退出客户端判为“连接未释放”。

因此停止烟测改用 `node scripts/run-official-runtime-controls.mjs`。启动器使用 Electron 工作区**已安装**的 esbuild，将诊断脚本临时编译到 `apps/electron` 下，正确解析官方 Claude SDK；运行后删除自己创建的构建目录。没有修改/安装产品依赖。旧 Node 试验把 bundle 放在 `scripts`，Claude SDK 无法从该目录解析，不能作为 Claude 不会启动的证据。

### 确认的产品问题：Codex 取消后保留连接

在正确 Node 观察端，官方 Codex 已返回 `interrupted`，但挂起的 Responses 流仍未在 6 秒内关闭；销毁该独占进程则关闭。这与 Claude 不同：正确 Node 环境中，Claude 软停止本身就能关闭流并继续下一轮，无需为它增加强制进程重建。

[官方 App Server 契约](https://learn.chatgpt.com/docs/app-server) 将取消请求应答与 `turn/completed` 的 `interrupted` 终态分开。TAgent 在此之上实施自己的 API 连接回收策略，不能将“RPC 已应答”当成“资源已经释放”。

## 本轮修复

- 仅针对官方 Codex API 会话：适配器收到原生 `interrupted` 后，先释放该会话的独占 App Server，再向宿主交付取消终态并结束旧 query。按 entry 身份校验，旧 query 不能关闭替换后的新实例。
- 保留原生 thread ID、durable home 与聊天记录。下一条**显式用户消息**使用原生 resume；不自动重发被停止的任务。正常完成的 Codex 回合与旧账号路径仍保持原有长驻行为。
- 配置重建增加旧 loop 退出等待：Chat/Work、工具/知识库、旁路上下文刷新等导致重建时，必须等待旧 generator 完成收尾。仅收到旧 result 不足以放行完整进程替换。
- IPC 首发/重建路径也等待旧 runtime 的收尾状态，避免创建新 SessionRuntime 时丢失旧状态。等待超时明确拒绝，不偷偷并行启动第二轮。
- 无需停止时保持原有发送时序；配置重建等待期间关闭会话，收尾后再次检查关闭状态，禁止重新启动已销毁的会话。

## 可复现检查

```powershell
# 两种真实官方可执行文件，回环 HTTP + 伪凭据；不调用公司网关
node scripts/run-official-runtime-controls.mjs

# 可选：只查工具，或只查某种内核的停止
$env:TAGENT_CONTROLS_MODE='tools'
node scripts/run-official-runtime-controls.mjs
$env:TAGENT_CONTROLS_MODE='interrupt'
$env:TAGENT_CONTROLS_RUNTIME='codex' # 也可用 claude
node scripts/run-official-runtime-controls.mjs
```

脚本逐项检查：

1. Codex Dynamic Tool 允许/拒绝；Claude 原生 Read 允许/拒绝。实际读取隔离 fixture，断言相应工具结果返回上游及成功终态。
2. 在上游响应挂起时停止，观察取消终态与 HTTP 关闭；不是仅检查停止按钮 ACK。
3. Codex 重建进程并原生 resume；Claude 保留进程续聊。只有新用户消息发出后才有下一次 HTTP 请求，旧用户消息在恢复上下文中恰好一次。

## 验证记录

- 主代理已独立运行完整 Node 控制面烟测：Codex/Claude 各自允许、拒绝、停止后继续，共 6 个场景通过。
- 最终集成后主代理独立重跑：15 个测试文件、200 项通过，覆盖 Codex 适配层、Claude adapter、SessionRuntime、runtime-switch、真实 IPC handler 与实机验收 worker 的判定逻辑。这是聚焦回归，不是全仓测试通过声明。
- 根目录 `bun run typecheck` 全工作区通过；Electron `bun run build:main` 与 `bun run verify:main` 通过；启动器 `node --check` 通过。未生成安装包。
- 最终构建时再次运行完整 Node 控制面烟测，6 个场景全部通过。未调用真实公司网关，未修改用户渠道、账号或聊天。
- 本轮涉及的已跟踪文件 `git diff --check` 通过，仅有 LF/CRLF 提示；测试产生的挂起 Vitest 进程按明确 PID 清理，未停止用户运行的 Agent。

聚焦回归命令：

```powershell
bunx vitest run apps/electron/src/main/lib/adapters/codex apps/electron/src/main/lib/adapters/claude/claude-agent-adapter.test.ts apps/electron/src/main/lib/agent/runtime/session-runtime.test.ts apps/electron/src/main/lib/agent/runtime/runtime-switch.test.ts apps/electron/src/main/lib/ipc/session-service.runtime-switch.test.ts scripts/official-runtime-live-worker.test.ts
```

## 仍不承诺

没有完成桌面 UI 全链路、真实公司网关下在飞写工具/原生子代理的停止、所有两两换核或长上下文接力。测试中的 Codex 工具是 Dynamic Tool，不是原生 Shell 写入。关闭本地连接也不保证远端服务停止计费或远端已接受任务能回滚。

本轮不改变 KSCC/Claude/Pi 的既有软停止策略，不做自动换核或自动任务重放。下一步是在桌面入口复核停止后续聊/换核，以及异常交接恢复。
