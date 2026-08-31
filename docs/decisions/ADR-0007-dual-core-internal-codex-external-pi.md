# ADR-0007：双核边界与内部 Native Agent 后端

**日期：** 2026-08-31  
**状态：** 方向确认，待分阶段实施

> **后续决策：** 本文确定的“双核产品架构、Internal 多后端、External Pi”
> 仍然有效。Codex 从一次性 CLI worker 升级为主后端的认证边界和 App
> Server 实施方案，见 [ADR-0008](./ADR-0008-codex-account-auth-and-app-server.md)。
> 本文第 7、9 节中关于 Codex worker 和待补主 Backend 的内容属于阶段性
> 基线，不再是最终接入形态。

## 1. 背景

TAgent 最初围绕公司 `kscc` CLI 建设。公司内部有较大的 kscc 使用额度，但原生入口主要是命令行，普通用户不容易使用。TAgent 通过桌面 UI、会话管理、权限、工作区和任务编排，把 kscc 变成可持续使用的 Agent 产品。

当前又出现了公司内部的大量 Codex 额度。Codex 在代码库理解、多轮工程任务、工具循环和长任务执行方面更适合作为编程 Agent 主力。因此，TAgent 需要支持 Codex 作为内部主执行后端。

这会暴露当前“双核”定义中的混杂：

- KSCC 当前作为独立核心，通过原生 SDK/CLI 长驻运行。
- Pi 当前作为进程内 Agent Loop，主要用于外部 HTTP API。
- Pi 内部还保留了 `kscc bare` 模式，造成 KSCC 能力重复和边界污染。
- 如果直接把 Codex 加成第三个核心，核心选择、会话配置和业务分支会继续扩散。

## 2. 决策

TAgent 继续保持**双核产品架构**，但内部核心允许有多个 Native Agent 后端：

```text
TAgent Host
├── External Core
│   └── Pi + HTTP API
│
└── Internal Core
    ├── KSCC Native Backend
    └── Codex Native Backend
```

这里需要区分两个概念：

```text
Core    = 面向发行版、用户群和运行边界的核心体系
Backend = 某个核心体系下的具体 Agent 执行后端
```

因此：

- `Pi` 是 External Core 的实现。
- `KSCC` 和 `Codex` 是 Internal Core 下的 Native Backend。
- `kscc bare` 不再作为 Pi Core 的正式模式。

## 3. 目标边界

### 3.1 External Core

External Core 面向外部人员和对外发行版，保持干净、通用和可移植：

```text
外部 API Key
  -> Pi Agent Loop
  -> HTTP Provider
  -> TAgent 通用工具与会话能力
```

External Core 不应依赖：

- 公司 kscc CLI
- 公司内部账号池
- 公司内部认证方式
- 公司内部专用协议
- 内部 Native CLI 运行时

### 3.2 Internal Core

Internal Core 面向公司内部使用，允许接入公司专用 Agent Runtime：

```text
公司内部 TAgent Host
  ├── KSCC Native Backend
  └── Codex Native Backend
```

两种 Backend 都可以复用 TAgent 的宿主能力：

- SessionRuntime
- 会话和消息落盘
- TAgent 统一事件/消息 IR
- Chat / Work / Plan 模式
- 权限和审批
- 工作区
- 看板与任务依赖
- 协作室
- 知识库与记忆
- 产物、测试和验收记录

Backend 自己负责处理其原生差异：

- 进程生命周期
- 多轮消息投递
- resume / session 恢复
- 流式事件解析
- 工具调用和工具结果
- 模型、usage 和错误映射
- MCP 或其它原生扩展

## 4. 当前代码事实

当前适配器入口仍然把核心类型写成：

```ts
type ChannelKind = 'kscc' | 'external'
```

见：

```text
apps/electron/src/main/lib/adapters/index.ts
```

其实际含义是：

```text
kscc-internal -> ClaudeAgentAdapter
其它渠道      -> PiAgentAdapter
```

同时，Pi 核内部仍有：

```text
PiKsccChannelConfig
createKsccBareStreamFn
```

见：

```text
apps/electron/src/main/lib/adapters/pi/pi-agent-adapter.ts
apps/electron/src/main/lib/adapters/pi/subagent-task-tool.ts
```

这条 `kscc bare` 路径不是正常主会话的主要运行路径。正常的 `kscc-internal` 渠道会进入独立的 KSCC 适配器。`kscc bare` 更接近历史兼容路径或特定协作桥接路径，不应继续作为 Pi 的对等能力维护。

当前已经存在可复用的上层适配器契约：

```text
apps/electron/src/main/lib/agent/runtime/session-runtime.ts
```

SessionRuntime 已经通过统一的 `query()`、`abort()` 和 `dispose()` 形态消费不同适配器的事件流。这是后续抽取 Backend Registry 的基础。

## 5. 目标抽象

不再让业务层直接依赖 `kscc` / `external` 分支，而是分离产品核心和具体后端：

```ts
type DistributionCore = 'internal' | 'external'
type InternalBackendId = 'kscc' | 'codex'
```

或者使用带核心信息的 Backend 类型：

```ts
type AgentBackend =
  | { core: 'external'; backend: 'pi' }
  | { core: 'internal'; backend: 'kscc' | 'codex' }
```

目标是通过注册表解析 Backend：

```text
channel / session configuration
  -> core resolver
  -> backend registry
  -> concrete adapter
  -> SessionRuntime
```

目标适配器接口应保持核心无关：

```ts
interface AgentBackendAdapter {
  id: string
  query(input: AgentTurnInput): AsyncIterable<TAgentEvent>
  abort(sessionId: string): void
  dispose(): void
}
```

其中 `AgentTurnInput` 只描述 TAgent 语义，例如：

```text
sessionId
prompt
cwd
permissionMode
executionMode
attachments
tools
mcpServers
signal
```

KSCC、Codex 和 Pi 各自把它转换为自己的原生参数。

## 6. `kscc bare` 的处理原则

### 正式结论

`kscc bare` 不再属于 Pi Core 的正式架构，不参与主会话 Backend 选择。

### 迁移策略

1. 从 `PiAgentAdapterConfig` 中移除 `PiKsccChannelConfig`。
2. Pi 核只保留 External HTTP API 模式。
3. `kscc-internal` 主会话始终走独立 KSCC Native Backend。
4. 如果协作室等特殊路径仍然需要 `createKsccBareStreamFn`，将其移动到明确命名的 Collaboration Bridge 或 Legacy Bridge。
5. 禁止新增依赖 Pi `kscc bare` 的主会话功能。

## 7. Codex 接入原则

Codex 不作为第三个产品核心，而作为 Internal Core 下的 Native Backend。

当前已有一次性 Codex CLI worker：

```text
apps/electron/src/main/lib/agent/cli-workers/run-codex-worker.ts
apps/electron/src/main/lib/agent/cli-workers/codex-stream-observer.ts
```

该 worker 可以复用于探索、审查和短任务，但不能直接等同于主会话适配器。Codex 主 Backend 还需要补齐：

- 长驻会话或可靠的连续 turn 管理
- Codex session / resume
- 主会话历史映射
- 工具权限与 TAgent 权限模式对齐
- 中断、超时和进程回收
- 附件、MCP、usage 和错误映射
- Windows 工具沙箱兼容性

特别注意：当前 Codex worker 固定使用 `-s read-only`，而协作室 CLI 成员要求 `workspace-write`。两者必须在 Backend 权限模型中统一，不能通过隐式放权解决。

## 8. 推荐的内部 Agent 分工

```text
TAgent 主会话
  -> 负责用户交互、上下文、计划和协调

KSCC Backend
  -> 公司内部知识、中文沟通、低成本分析、备用执行

Codex Backend
  -> 深度代码理解、重构、测试和长任务执行
```

典型任务流程：

```text
用户需求
  -> TAgent 建立任务与依赖
  -> KSCC 查询公司规范和历史知识
  -> Codex 执行代码修改
  -> KSCC 或 Codex 做审查
  -> TAgent 汇总 diff、测试、风险和验收结果
```

TAgent 的价值不是替某一个模型回答问题，而是把内部 Agent 组织成可交付的工作流。

## 9. 分阶段实施

### 阶段一：清理核心边界

- 将 Pi 限定为 External HTTP Core。
- 删除或隔离 Pi 内部的 `kscc bare` 正式类型。
- 保持现有 KSCC 主路径不变。
- 把 `ChannelKind` 等命名从“渠道类型”调整为“核心/后端类型”。

### 阶段二：建立 Backend Registry

- 保留现有 `getAdapter()` 作为兼容入口。
- 内部改为 Backend Registry。
- 让 SessionRuntime 只依赖统一适配器契约。
- 将 `session-service.ts` 中的后端特化分支逐步移入各 Backend。

### 阶段三：接入 Codex Native Backend

- 先实现 Codex 主会话的最小连续 turn。
- 复用已有 Codex JSONL observer。
- 完成 read-only / workspace-write 权限映射。
- 解决 Windows 工具沙箱问题。
- 再补 resume、附件、MCP 和完整历史恢复。

### 阶段四：内部工作流增强

- Codex、KSCC 按能力自动路由。
- 任务看板支持指定 Backend。
- 支持“KSCC 分析 -> Codex 实现 -> Agent 审查”的固定流程。
- 将知识库、记忆、产物和测试证据纳入统一交付记录。

## 10. 非目标

本决策不要求：

- 把 Pi 改造成内部 Agent Runtime。
- 让 KSCC 和 Codex 共享同一套原生协议。
- 立即重写所有现有适配器。
- 通过 HTTP 直连公司私有网关替代原生 CLI。
- 为了抽象而抽象，破坏当前可用的 KSCC 主路径。

## 11. 最终结论

TAgent 的正确架构不是：

```text
KSCC Core + Pi Core + Codex Core
```

而是：

```text
双核产品架构：

External Core = Pi + HTTP
Internal Core = KSCC Native Backend + Codex Native Backend
```

`kscc bare` 不属于 Pi Core 的未来方向。它应被移出正式核心模型，最多作为隔离的兼容桥接保留。

最终目标是：

> **一个 TAgent Host，外部用干净的 Pi HTTP，内部用 KSCC/Codex Native Backend；统一会话、权限、知识、任务和交付。**
