# ADR-0008：Codex 账号认证与 App Server 主核

**日期：** 2026-08-31  
**状态：** 实施中
**关联：** [ADR-0007：双核边界与内部 Native Agent 后端](./ADR-0007-dual-core-internal-codex-external-pi.md)

## 1. 背景

TAgent 的 Internal Core 不能假设能够拿到 Claude Code/kscc 或 Codex
的上游 API Key。公司内部使用的是已经授权的 CLI 服务，认证、额度和
访问策略由公司账号或 CLI 运行时持有。

此外，普通用户也可能购买的是订阅套餐。此类用户通过账号登录 Codex
CLI，使用账号关联的订阅额度，而不是通过 OpenAI Platform API Key
调用模型。TAgent 既不需要、也不应该把这种账号认证提取成 API Key。

因此，以下两类环境具有相同的认证边界：

```text
公司内部：
  公司账号/企业 CLI 授权 -> Codex CLI -> 公司额度

订阅用户：
  ChatGPT 账号登录 -> Codex CLI -> 订阅额度
```

TAgent 的职责是接管已经授权的 Agent Runtime，而不是接管或复制其凭证。

## 2. 决策

### 2.1 Codex 成为 Internal Core 下的完整主后端

TAgent 仍然保持双核产品架构：

```text
TAgent Host
├── Internal Core
│   ├── Codex App Server Backend    默认主后端
│   └── KSCC Native Backend         备用主后端
└── External Core
    └── Pi + HTTP API
```

这里的“默认主后端”是可配置和可回退的产品策略，不代表删除 KSCC。
KSCC 保留作为成熟备用核、兼容核和特定内部任务后端。

### 2.2 Codex 主会话使用 App Server，不使用一次性 exec worker

现有 Codex worker：

```text
apps/electron/src/main/lib/agent/cli-workers/run-codex-worker.ts
```

继续作为 L1 短命子代理、探索任务和兼容兜底路径。

Codex 主会话必须新增独立的：

```text
CodexAppServerAdapter
```

目标链路：

```text
TAgent SessionRuntime
  -> CodexAppServerAdapter
  -> 本机 codex app-server
  -> Codex 原生 Agent Runtime
```

不得通过不断扩张 `runCodexWorker` 的方式模拟主会话。

### 2.3 凭证由 Codex Runtime 持有

Codex 主核采用以下凭证边界：

```text
TAgent
  不读取 Codex OAuth token
  不复制 Codex auth 文件
  不把账号认证转存为 API Key
  不把认证信息转发到外部服务

Codex CLI/App Server
  自己读取当前用户可用的登录状态
  自己决定使用公司额度或订阅额度
```

TAgent 只在当前用户权限下启动本机 `codex app-server`，通过本地
JSON-RPC 连接接收和发送 Agent 事件。

这是一个运行时边界，而不是 API 网关边界。

## 3. 为什么选择 App Server

Codex 的 `exec --json` 适合一次性脚本和短命后台任务，但不足以承载
TAgent 的完整主会话体验。

App Server 面向需要深度集成 Agent 的客户端，提供双向会话协议。目标
能力包括：

```text
thread/start
thread/resume
turn/start
turn/steer
turn/interrupt
流式消息事件
命令执行事件
文件变更事件
审批请求
turn/completed
```

这组能力与 TAgent 的主会话契约直接对应：

| TAgent 能力 | Codex App Server 语义 |
|---|---|
| 新建会话 | `thread/start` |
| 多轮发送 | `turn/start` |
| 引导当前 Agent | `turn/steer` |
| 用户停止 | `turn/interrupt` |
| 重启恢复 | `thread/resume` |
| 文本流 | Agent message delta |
| 工具进度 | command/tool item events |
| 写文件审批 | file change approval |
| 命令审批 | command approval |
| 回合结束 | `turn/completed` |

因此，Codex 可以采用“产品上长驻、底层由 App Server 管理 native thread”
的主核模型，不需要用文本输出或一次性 exec 反推会话状态。

官方参考：

- [Codex SDK](https://developers.openai.com/codex/codex-sdk)
- [Codex App Server](https://developers.openai.com/codex/app-server)
- [Codex CLI](https://developers.openai.com/codex/cli)

## 4. 目标架构

### 4.1 Backend Registry

业务层不再直接通过 `kscc` / `external` 分支判断运行方式，而是解析
统一 Backend：

```ts
type AgentBackend =
  | { core: 'internal'; backend: 'codex-app-server' }
  | { core: 'internal'; backend: 'kscc' }
  | { core: 'external'; backend: 'pi-http' }
```

解析链路：

```text
session/channel configuration
  -> core resolver
  -> backend registry
  -> concrete adapter
  -> SessionRuntime
```

### 4.2 统一主核适配器契约

适配器对外只暴露 TAgent 语义，不把 SDK、Pi 或 Codex 原生消息泄漏
到渲染层：

```ts
interface AgentBackendAdapter {
  id: string
  query(input: AgentTurnInput): AsyncIterable<TAgentEvent>
  send(sessionId: string, input: AgentTurnInput): Promise<void>
  interrupt(sessionId: string): Promise<void>
  resume(sessionId: string): Promise<void>
  setPermissionMode?(sessionId: string, mode: string): Promise<void>
  hasLiveProcess(sessionId: string): boolean
  dispose(sessionId: string): Promise<void>
}
```

`TAgentEvent` 最终映射到现有：

```text
TAgentMessage
TAgentControlEvent
```

渲染层不区分 Codex 和 KSCC 的原生协议，只在能力矩阵中显示少量
真正存在的差异。

## 5. Codex Adapter 责任

### 5.1 进程与连接

- 在 Electron main 进程启动本机 `codex app-server`。
- 优先使用 `stdio` JSON-RPC，避免增加不必要的网络监听面。
- 记录 app-server PID、连接状态和 stderr 尾部。
- session 销毁、应用退出和异常恢复时回收进程。
- 每个用户/配置作用域隔离 Codex runtime，避免会话串线。

### 5.2 Thread 与 turn

- 首轮创建 Codex native thread。
- 持久化 `threadId`，并绑定 TAgent `sessionId`。
- 后续消息使用同一 thread。
- Codex runtime 重启后使用 `thread/resume`。
- TAgent JSONL 继续保存产品侧消息和面板历史。
- Codex thread 是执行真值，TAgent session 是产品真值，二者通过
  `sessionId <-> threadId` 映射。

### 5.3 事件归一化

目标映射：

```text
thread started
  -> native session id / session ready

agent message delta
  -> stream_text_delta

command execution started
  -> assistant tool_use / progress

command execution completed
  -> tool_result

file change request
  -> approval request / file change event

turn completed
  -> result + usage + turn_end

server error / turn failed
  -> structured session error
```

不能只保留最终摘要。主核路径必须保留流式阶段、工具调用、审批和
错误事件，否则用户体验仍然只是 CLI worker。

### 5.4 权限和审批

TAgent 的权限模式继续作为上层产品契约：

```text
Chat  -> 只读边界
Work  -> Plan / 自动 / 完全自动
```

Codex 的沙箱和审批参数作为底层实现映射：

```text
TAgent permission mode
  -> Codex sandbox policy
  -> Codex approval policy
```

优先使用 App Server 原生审批请求接入 TAgent 权限服务。
如果某个 Codex 版本没有暴露足够细的审批事件，则退化为进程级
沙箱策略，并在能力矩阵中明确标识，不通过隐式放权伪造等价。

## 6. SDK 与 App Server 的选择

### 6.1 首选直接连接本机 App Server

由于 TAgent 的关键约束是“使用当前机器已经授权的 Codex CLI”，首期
优先直接启动和连接本机安装的：

```text
codex app-server
```

这样可以显式控制：

- 使用哪个 Codex 可执行文件
- 使用哪个 Codex 版本
- 使用哪个用户环境和配置目录
- 是否继承公司 CLI 的认证状态
- 是否在 Windows 下正确回收进程树

### 6.2 TypeScript SDK 作为封装候选

`@openai/codex-sdk` 可以作为 Node.js 集成封装和协议参考，但不能在
没有验证的情况下假定它一定使用公司当前安装的 CLI、配置和认证状态。

SDK 版本、App Server 版本和协议 schema 必须纳入兼容性检查。TAgent
应该优先保证“实际启动的 Codex binary 与公司授权环境一致”，再决定
是否用 SDK 替代部分 JSON-RPC 管理代码。

### 6.3 官方 Runtime 的解析与按需托管

**2026-09-01 补充决策：** Codex Desktop 的私有安装目录和内部进程不是
TAgent 的正式集成接口。只安装 Desktop 的用户不保证系统 `PATH` 中存在
可调用的 `codex`，因此主核不能把“已安装 Desktop”等同于“App Server
Runtime 可用”。

TAgent 按以下优先级解析 Codex Runtime：

```text
用户显式指定的 codexPath
  -> TAGENT_CODEX_PATH
  -> 系统 PATH 中的 codex
  -> TAgent 按需托管的官方 Codex Runtime
```

每个候选都必须通过：

```text
codex --version
codex app-server --help
codex features list
```

仅找到同名命令但不支持 App Server 时，继续尝试下一候选，不把旧版或
非官方同名程序误判为主核。特性列表还必须包含：

```text
default_mode_request_user_input
exec_permission_approvals
request_permissions_tool
```

避免旧版 Runtime 在 UI 中显示可用、真正启动 App Server 时才因未知
feature 参数失败。

托管 Runtime 的发行原则：

- 默认直接下载 OpenAI 官方发布的对应平台 Codex CLI 包。
- TAgent 固定受支持版本，不直接追随 `latest`。
- 下载清单记录版本、平台、架构、SHA-256 和官方来源。
- 公司内网可以缓存官方原包，但必须使用相同哈希校验。
- 不复制 Codex Desktop 私有 runtime，不依赖其内部目录结构。
- 不读取或迁移 Codex token；启动后的账号认证仍由 Codex Runtime 持有。

Windows x64 的 `codex-cli 0.151.0` 本地实测基线：

```text
完整 Runtime 落盘约 395 MiB
完整平台包压缩后约 142 MiB
```

因此标准发行版采用按需下载；需要离线部署的公司内部版本可以预装同一
官方 Runtime。

## 7. 当前实现的迁移边界

### 保留

- `run-codex-worker.ts`：L1 短任务和兜底。
- `codex-stream-observer.ts`：可复用部分事件解析思路。
- `run-ndjson-cli.ts`：进程树、取消、Windows prompt 和 stderr 处理。
- `TAgentMessage`：统一渲染 IR。
- `SessionRuntime`：恢复、停止、执行形态和生命周期骨架。
- session JSONL、workspace、协作室、看板和权限服务。

### 新建或抽取

- `CodexAppServerAdapter`
- Codex JSON-RPC transport
- App Server notification/request parser
- `threadId` 持久化和恢复映射
- Codex approval bridge
- Codex usage/error normalization
- Backend Registry
- 与 SDKMessage 无关的通用 `TAgentEvent` 主核契约

### 需要逐步清理

- `session-service.ts` 中只理解 KSCC SDKMessage 的分支。
- `SessionRuntime` 中对 `type === 'result'` 的 KSCC/Pi 兼容判断。
- 把 `ChannelKind` 直接等同于 `kscc | external` 的业务逻辑。
- 将 Codex 永久限制为 `--ephemeral` 和 `read-only` 的主核路径。

## 8. 分阶段实施

### 2026-09-01 实施进度

当前已完成 Phase 0，并形成 Phase 1 的主链路骨架：

- Runtime 解析与 App Server 能力探针。
- stdio JSON-RPC 握手、请求关联、反向请求 fail-closed 和进程回收。
- `thread/start`、`thread/resume`、`turn/start`、`turn/steer`、
  `turn/interrupt`。
- `sessionId <-> codexThreadId <-> active turnId` 映射和持久化。
- 文本、reasoning、命令、文件变更、MCP、usage、错误事件到 TAgent IR。
- Codex 原生审批请求接入 TAgent 权限服务的命令/文件变更入口。
- Internal 会话输入区已提供 Codex / Claude Code 会话级选择；运行中禁止
  拆换后端，新会话首发会把选择写入 session meta。
- 输入区会探测本机或 TAgent 托管的 Codex Runtime，显示版本与来源；
  Runtime 不可用时禁用 Codex 选择。
- Windows x64 可从输入区按需安装经过版本和 SHA-256 固定的 OpenAI 官方
  Codex 平台包；安装器使用 staging、App Server 能力探针和原子清单激活，
  Windows 目录暂时占用时退避重试，失败不会污染现有 Runtime。
- `item/tool/requestUserInput` 已映射到现有 AskUserQuestion 横幅，支持
  选项、自定义输入、Codex question id 回传和 secret 输入。
- `item/permissions/requestApproval` 已映射到现有 PermissionService：
  Work 完全自动按请求授权，Plan 拒绝，Chat 对网络/写入扩权硬拒绝，
  自动模式进入原有权限横幅。
- Codex 扩权固定使用 `scope: turn`；横幅不展示“始终允许”，避免一次
  网络或目录授权退化为会话级通配。
- 工作区启用的外部 `stdio` / Streamable HTTP MCP 已投影到
  `thread/start.config.mcp_servers` 和 `thread/resume.config.mcp_servers`。
  `command`、`args`、`env`、`startup_timeout_sec`、`url` 和
  `http_headers` 均按 Codex 配置字段转换。
- TAgent legacy SSE MCP 暂不投影；TAgent 内置 browser、KB、kanban
  不启动额外 MCP 子进程，而是复用现有 Pi `AgentTool` handler，通过
  App Server `thread/start.dynamicTools` 注册到 Codex thread。
- Dynamic Tool 注册集合不按 Chat / Work 裁剪。新 thread 始终注册完整
  browser、KB、kanban 集合，调用时再读取当前执行形态和权限模式门控，
  因此同一会话可无痛切换 Chat / Work，不需要重建工具定义。
- Dynamic Tool 权限分为三类：
  - `read-only`：browser 打开、导航、观察、滚动、截图、接管/恢复，
    KB 列表、检索、读取、附件解析，以及看板列表，直接执行。
  - `permission`：browser 点击/输入与看板创建、追加、完成、阻塞，
    复用 TAgent PermissionService；Chat 拒绝，Work 按 Plan / 自动 /
    完全自动策略处理。
  - `self-authorized`：`kb_propose_save` 在 Work 自动/完全自动下直接进入
    自身知识入库确认横幅，避免重复 PermissionBanner；Chat 或 Plan
    仍先由 PermissionService 拒绝。
- Codex developer instructions 已注入受管浏览器、知识库和 Work 看板
  使用规则；Dynamic Tool started/completed 事件归一化为现有
  `tool_use` / `tool_result`，失败结果带 `isError: true`。
- App Server 异常退出后向 `SessionRuntime` 暴露 EOF，并使用
  `resumeThreadId` 尝试一次恢复。

本机 `codex-cli 0.151.0` 已完成真实临时只读 turn：

```text
prompt: 仅回复 CODEX_APP_SERVER_OK，不调用任何工具。
result: CODEX_APP_SERVER_OK
events: text delta -> final assistant -> completed result + usage
```

`requestUserInput` 在 `codex-cli 0.151.0` 中仍属于 experimental API。
TAgent 启动 App Server 时显式启用：

```text
codex app-server --stdio
  --enable default_mode_request_user_input
  --enable exec_permission_approvals
  --enable request_permissions_tool
initialize.capabilities.experimentalApi = true
```

真实反向请求烟测：

```text
model -> item/tool/requestUserInput
TAgent -> answers: { <questionId>: { answers: ["Beta"] } }
model -> USER_INPUT_OK:Beta
```

MCP 真实线程烟测：

```text
thread/start.config.mcp_servers.tagent_smoke_missing
  -> mcpServerStatus/list
  -> name = tagent_smoke_missing
  -> runtimeStatus = failed（预期：故意使用不存在的可执行文件）
```

这证明会话级 MCP 配置已被 App Server 接收并进入目标 thread 的 MCP
运行时，而不是只在 TAgent 内部完成了对象转换。

Dynamic Tool thread 持久化真实烟测：

```text
1. thread/start 注册 tagent_echo
2. 第一轮收到 item/tool/call，返回 ECHO:first
3. 关闭 App Server
4. 新 App Server 仅调用 thread/resume，不重复传 dynamicTools
5. 第二轮仍收到 item/tool/call，返回 ECHO:resumed
```

本机 `codex-cli 0.151.0` 结果表明 Dynamic Tool 定义随原生 thread
持久化，恢复会话时无需也不能向 `thread/resume` 注入未声明字段。

真实内置工具烟测：

```text
2026-09-01 / codex-cli 0.151.0
  kb_list_available -> item/tool/call -> 返回实际知识库元数据
  kanban_list_boards -> item/tool/call -> 返回 { count: 0, boards: [] }
```

两次调用均经过 `CodexDynamicToolRegistry` 和统一权限分派，随后由
Codex 正常生成最终文本。说明内置 KB / 看板 handler 已经跨过
“协议注册成功”阶段，能够在真实主会话中被模型调用并返回结果。
受管浏览器仍需在 Electron BrowserController 已初始化的桌面进程中
进行端到端验证，命令行 smoke 不替代该验证。

`item/permissions/requestApproval` 的客户端反向 RPC、参数解析、TAgent
权限策略和响应结构已由聚焦测试覆盖。模型自然触发烟测在当前 Windows
环境遇到 Codex 沙箱 `CreateProcessWithLogonW failed: 1385`，未形成可
复现的真实扩权请求，因此不把该次尝试记录为通过；后续应在可正常创建
Codex 沙箱进程的 Windows 环境再补一次端到端确认。

开发阶段仍可用环境变量指定新建 internal 会话的缺省后端和模型；产品
界面现已支持逐会话选择：

```text
TAGENT_INTERNAL_BACKEND=codex
TAGENT_CODEX_MODEL=<可选，缺省使用 Codex Runtime 默认模型>
```

会话一旦写入 `internalBackend` / `codexThreadId` 就按会话绑定，不跟随
后续环境变量漂移。Codex 与 KSCC 分别保留自己的 native thread/session
id，切回对应后端时恢复各自上下文。新建 Internal 会话在 Codex Runtime
可用时默认使用 Codex App Server；Runtime 不可用时回退 KSCC。应用内
完成托管 Runtime 安装后会立即失效旧的 KSCC fallback 探测缓存。

### Phase 0：账号认证与协议探针

验收：

- 当前已登录 Codex CLI 的机器可以启动 `codex app-server`。
- TAgent 不读取或复制认证文件。
- 可以完成 initialize/handshake。
- 可以创建 thread。
- 可以发起一个只读 turn。
- 可以收到结构化流式事件。

### Phase 1：Codex 主核最小闭环

验收：

- 新建会话。
- 多轮发送。
- 文本增量展示。
- 命令执行过程展示。
- turn 完成和失败展示。
- 用户停止。
- 应用退出后重新启动并恢复 thread。

### Phase 2：主会话体验对齐

验收：

- Chat / Work 双模式。
- steer。
- Plan / 自动 / 完全自动权限映射。
- 文件变更展示。
- MCP。
- 附件。
- No-Progress Guard。
- usage 和错误分类。

### Phase 3：系统级接管

验收：

- Codex 可设置为默认 Internal Backend。
- KSCC 可作为会话级或任务级备用 Backend。
- 协作室支持 Codex 正式成员。
- 看板支持 Codex 长任务。
- Codex 与 KSCC 共享 session、workspace、权限和交付证据契约。

## 9. 验收标准

“Codex 已成为主核”必须满足：

1. 用户不需要在 TAgent 中填写 Codex API Key。
2. 账号订阅登录和公司 CLI 授权都能在本机工作。
3. Codex 具备独立的多轮主会话，而不是一次性 worker。
4. TAgent 能处理 Codex 的流式消息、工具、审批、文件变更和错误。
5. Codex 支持停止、引导、恢复和应用重启后的继续。
6. Chat、Work、协作室、看板和历史记录不依赖 KSCC 特殊分支。
7. KSCC 仍然可以作为备用 Internal Backend 使用。
8. Codex 认证信息不会进入 TAgent 渠道配置、日志、JSONL 或外部请求。

## 10. 非目标

本决策不要求：

- 获取或维护 Codex 上游 API Key。
- 复制 Codex OAuth token 或 auth 文件。
- 让 Codex 和 KSCC 使用相同的原生协议。
- 把 Pi 改造成 Internal Core。
- 删除现有 Codex CLI worker。
- 在 App Server 协议未验证前直接切换默认主核。
- 为了表面上的完全一致而隐藏 Codex 与 KSCC 的真实能力差异。

## 11. 最终结论

TAgent 的“无 API Key”场景不是缺陷，而是运行时边界：

```text
模型凭证和额度：
  由用户账号、公司账号或 CLI runtime 持有

TAgent：
  持有会话、任务、工作区、权限、协作和交付状态
```

因此，Codex 最适合通过本机 `codex app-server` 成为 Internal Core
的默认主后端。TAgent 不需要拥有 Codex API Key，也不需要复制账号
认证；只需要在授权边界内接管 Codex 的正式 Agent 协议。

最终目标：

```text
Internal Core
  = Codex App Server Backend（默认）
  + KSCC Native Backend（备用）

External Core
  = Pi + HTTP API
```

TAgent 的产品价值是：

> **将用户或企业已经授权的 Claude Code/KSCC 与 Codex Agent Runtime，
> 统一成可交互、可恢复、可协作、可审计的开发工作系统。**
