# ADR-0012：官方多内核与 API 渠道解耦

日期：2026-09-17。状态：方向已确认，开始实施；本文不是验收通过声明。

取代 ADR-0011 中“先以 KSCC 承载第三内核”及“渠道 provider 决定内核”的过渡策略。保留其停止确认、权限、宿主历史、交接事务和不自动重放的原则。

> **2026-10-08 修订：KSCC 转为内置 HTTP 网关渠道，CLI 通路整体移除。** 下文 §1「KSCC 只保留旧配置/旧会话兼容」与 §3「旧 KSCC 仍按旧路径运行」已被取代：TAgent 不再 spawn `kscc.exe`，kscc 改为一个**内置 HTTP 渠道**（provider `kscc-gateway`，默认 `anthropic-messages` 协议），内核完全由 Pi / 官方 Codex / 官方 Claude Code 承载。网关按请求头 `ksyun-code-type` 做客户端准入（值不校验），该头由渠道层统一注入：Pi 经 `createHttpDirectStreamFn` 的 `headers`、官方 Claude Code 经 `ANTHROPIC_CUSTOM_HEADERS`、官方 Codex 与 loopback 桥经 `upstreamHeaders`。渠道凭据不落 `channels.json`，改从本机 kscc 配置（`~/.claude/settings.json` 的 `ANTHROPIC_AUTH_TOKEN`，回退 KCwork `kscc-credential.json`）同步读取，无手填入口。内置渠道在渠道页显示为固定卡片，不可新建/删除、连接配置不可编辑。

## 1. 产品决策

TAgent 是多 Agent 工作台：首批为定制 Pi、官方 Codex、官方 Claude Code。新主线使用用户配置的 API 地址、密钥和模型，不依赖 KSCC 或本机已登录账号。Pi 保留深度定制；官方内核使用官方执行循环和工具协议，宿主负责统一交互、任务编排、接力、权限与成果管理。

KSCC 的 CLI 通路已整体移除；历史 `kscc-internal` 渠道记录保留在磁盘上但不可运行（`isChannelCompatibleWithRuntime` 对其恒返回 false），旧会话仍可显示真实旧内核。2026-10-08 起，kscc 以**内置 HTTP 网关渠道**（`kscc-gateway`）形式接入，与用户自建 API 渠道并列但不可编辑连接配置。旧 Codex 账号渠道同样只供历史兼容。渠道页不再固定展示 Codex App Server 卡片；这不意味着删除底层官方 App Server 通信接口。

## 2. 四个独立概念

| 概念 | 职责 | 用户入口 |
| --- | --- | --- |
| 内核 | Pi / Codex / Claude Code；安装、版本、启动、原生会话 | Agent 接入 |
| API 渠道 | 地址、密钥、明确的接口协议、模型列表及容量 | 渠道 |
| 助手预设 | 名称、内核、渠道/模型引用、角色与工具偏好 | 复用角色/预设，不新增重复角色系统 |
| 任务会话 | 固定当前执行绑定、历史、成果、交接和审批状态 | 聊天、子任务、现有看板 |

选择顺序为“内核 → 渠道 → 模型”。渠道协议是连接属性，不是用户需要理解的内核限制；官方运行时通过宿主适配层接入不同协议。新会话默认 Pi；旧会话不自动换核。显式内核绑定必须独立保存，不能从外部 API 渠道反推为 Pi。

## 3. 第一期技术契约

- `AgentRuntimeKind` 新增 `claude-code`，`kscc` 标为历史兼容；主入口只列 `pi/codex/claude-code`，旧会话仍可显示真实旧内核。
- 会话及首条发送保存/传递 `agentRuntime`；`internalBackend` 保留原字段并可表示 `claude-code`，用于旧协议兼容。新绑定以显式字段为准。
- API 渠道新增可选 `apiProtocol`：`anthropic-messages`、`openai-responses`、`openai-chat`。未配置的旧渠道保持原 provider 对应行为，不静默改变请求格式。
- 官方运行时对内保持原生协议：Claude Code 接 Anthropic Messages，Codex 接 OpenAI Responses；主进程通过 loopback protocol bridge 把 `openai-chat`、`openai-responses`、`anthropic-messages` 三种上游协议转换到目标内核协议。Pi 继续直连渠道。
- 主进程校验与界面共用“是否存在可用外部 API 渠道 + 是否有适配器”规则，不再把上游协议直接暴露为内核门槛。未知协议、停用渠道、缺失模型或适配器才拒绝；不自动回落、不偷偷替换模型或放宽权限。
- Claude 使用已依赖的官方 Agent SDK/官方运行文件，不存在 `resolveKsccPath`/`spawnKscc` 路径（kscc CLI 通路已于 2026-10-08 移除）。
- Codex 继续使用官方 App Server，新增独立 API 配置与凭据注入。不同渠道/会话不得串用环境或认证；不修改用户全局 Codex/Claude 设置，不把上游密钥写入聊天、日志或命令行参数。
- 原生配置/凭据变化必须使相应运行实例失效，重建前确认旧回合结束；不能仅改变模型显示而复用错误连接。旧原生 ID 不跨不兼容绑定复用。
- 本期按会话、渠道、地址、模型、容量和原生协议隔离官方运行目录。同一绑定可恢复原生会话；换渠道/模型走同一交接事务。原渠道就地修改地址或密钥时停止复用旧实例，恢复不安全则明确报错，不自动投递任务；完整修复入口纳入 B。

## 4. Hermes Studio 的借鉴范围

依据本机 `F:/hermes-studio` 的静态源码核对：

- `modules/coding-agents/services/index.ts`：独立配置、内核/渠道组合、模型容量配置。
- `modules/coding-agents/protocol/*`：本地目标注册、协议转换、统一事件与上游凭据隔离；已将其中的协议转换思路移植到 TAgent 的官方 runtime bridge，不引入 Hermes 服务进程。
- `services/runtime/run-manager.ts`：运行兼容判定、原生恢复和进程生命周期。
- `services/update-policy.ts`：版本检查、运行繁忙时推迟升级和升级锁。

借鉴分层，不复制整个服务端实现；TAgent 只保留自己的 Electron 生命周期、权限和会话边界。协议转换代码按本项目需要移植并补充本地测试，不照搬默认绕过审批/沙箱的执行参数。源码存在与测试用例存在，不等于本机多内核长会话接力已实测可靠。

## 5. 实施顺序及验收门槛

### A. 三内核 + API 渠道（当前开发）

1. 增量契约与兼容校验，历史绑定保持不变。
2. 标准 Claude Code / Codex 使用独立配置连接自有 API。
3. 渠道去掉固定内核卡；内核安装/检测回到 Agent 接入；首条消息、续聊和切换都使用同一显式绑定。
4. 验证每条路径的多轮、工具、停止、审批、错误和重启；验证三种上游协议经过桥接后的请求、SSE、工具调用和终态；新增跨层 Codex `completed` 成功终态回归。

验收：配置兼容 API 后，无需 KSCC 或预先登录账号，三内核能分别执行；不串渠道/密钥/原生会话。不以“三种选项能点”代替实际执行验收。

### B. 可靠接力（下一切片）

修复交接异常恢复；支持用户确认后重新准备上下文，不自动重放任务。保存目标、约束、进展、成果、未完成项和历史截止位置；容量按目标模型管理。用户知道交接省略了什么，宿主记录完整不等于原生上下文无损迁移。

### C. 多 Agent 协作

复用子任务、MOA、看板，提供评审、并行调查和接手。先并行只读，同工作区写入先串行；隔离工作区与合并验证后再开放并行写入。之后再引入更多官方内核和有测试支撑的协议转换。

## 6. 暂不做

不做自动判断模型“降智”、自动换核重放、无能力声明的“全能转换”；不搬运 Hermes 内核实现，也不引入大型 DAG 编辑器。官方升级要经过协议回归和实际烟测，不盲目跟最新版本。

## 7. 验证与回滚

每个切片分别记录：已实现代码、模拟测试、真实协议测试、桌面操作验收、未覆盖项。旧 KSCC/Codex 配置只隐藏或归入兼容，不删除历史；新路径失败不改旧绑定。发布前验证新建/续聊/重启/两两切换、API 失败和密钥隔离。

参考官方接入契约： [Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Codex 自定义渠道](https://learn.chatgpt.com/docs/config-file/config-advanced)、[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/quickstart)。
