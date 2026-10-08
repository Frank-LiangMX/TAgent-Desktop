# 官方内核 + API 渠道：实施与验收

日期：2026-09-17。对应 [ADR-0012](../../decisions/ADR-0012-official-runtimes-api-channels.md)。状态：第一切片代码已集成、本地文本协议通过；真实 API 文本/原生进程恢复部分通过。两官方内核的本地工具允许/拒绝、停止连接释放与显式续聊已通过；桌面端到端仍未完成，尚未判为发布通过。证据见 [真实 API 验收](official-api-live-acceptance-2026-09-17.md) 与最新 [停止与续聊验收](official-runtime-stop-acceptance-2026-09-17.md)。

## 本切片边界

新主线为 Pi、官方 Codex、官方 Claude Code。KSCC 与旧 Codex 账号渠道仅保留历史兼容；不删除旧记录，不把 KSCC 改名冒充官方路径。Codex App Server 仍是底层通信协议，但不再作为固定 API 渠道展示。

用户先选内核，再选兼容渠道和模型。渠道保存显式协议，未配置协议的旧渠道保持原行为：

| 原生接口 | Pi | Codex | Claude Code |
| --- | --- | --- | --- |
| Anthropic Messages | 支持 | 不匹配 | 支持 |
| OpenAI Responses | 支持 | 支持 | 不匹配 |
| OpenAI Chat Completions | 支持 | 不匹配 | 不匹配 |

表格表示实现的协议路径，不表示任意模型均已通过工具、多轮和公司网关实测。Google 原生协议延续 Pi 旧路径，不新增转换器。

## 集成检查重点

- `agentRuntime` 独立保存；创建、首发、续聊、重开及切换不得按外部渠道反推回 Pi。
- 不仅比较渠道 ID：地址、密钥、协议、模型容量等连接配置变化也不能复用错误进程。
- 官方运行目录由 TAgent 管理并按会话/绑定隔离，保留原生续聊所需数据，不使用用户全局登录配置。仅环境传递上游密钥，不写进启动参数或原生配置文件。
- 配置变更造成恢复不安全时明确拒绝，不偷偷新开空白上下文；接力恢复入口属于后续切片。
- 渠道测试、Pi 主会话、子任务、MOA 和记忆整理应尊重显式协议。
- 协作室原生工具桥本期仍仅开放已验证的 Messages 路径；Responses/Chat 纯文本席位不能被显示为已经支持工具。
- Codex 的 `completed` 应视为成功终态；错误、取消或未知状态不消费交接资料。

## 验证层级

1. 纯逻辑、存储、IPC 和适配器模拟测试。
2. 本地 HTTP 协议测试：运行真实 Pi HTTP 客户端，断言 `/responses`、所选模型、请求格式、鉴权与流式结束事件；仅使用伪密钥和回环地址。
3. 官方可执行文件的本地协议烟测（与模拟客户端测试分开记录）。
4. 公司网关 + 桌面 UI 的多轮、工具、停止、审批、错误、重启和两两接力验收。

前三层通过不能代替三内核真实网关/桌面验收。

## 已知边界

- 跨内核交接仍是有界可见历史，不迁移隐藏推理、在飞工具或完整原生状态；不是“无损换核”。
- 交接结果不明后的恢复 UI、按目标容量整理交接、并行工作区隔离，仍属后续切片。
- 渠道存储沿用原有 Electron `safeStorage` 实现；系统加密不可用时的既有降级策略未在本切片重做，不能宣称所有环境下密钥均已加密。
- 官方内核需要兼容原生协议的网关；没有加入任意协议转换服务，也不保证网关供应商名称与所提供协议相同。
- 官方会话换模型/渠道也使用交接事务，新建原生上下文；不是原生上下文内的无损模型热切换。原渠道就地改密钥或地址后会阻止不安全恢复，原会话的直接修复入口尚未实现。
- 参考 Hermes 的分层与生命周期设计，不复制其 BSL 1.1 源码。

## 最终验证（2026-09-17 11:42）

主代理在集成后的同一工作树独立执行：

| 检查 | 结果 |
| --- | --- |
| 聚焦回归（共享、HTTP、渠道、记忆、协作室、适配器、存储、IPC、界面选择） | 26 文件、344 项通过 |
| 根目录 `bun run typecheck` | 全工作区通过 |
| Pi core、Electron main/preload、renderer 构建 | 通过 |
| `bun run verify:main` | 通过；无 Pi ESM 包运行时 require |
| 本切片涉及的已跟踪文件 `git diff --check` | 通过；仅换行格式提示 |
| 真实 Pi HTTP 客户端 → 回环 Responses SSE | 通过，1 项 wire test |
| `bun scripts/official-runtime-smoke.ts` | 真实 Codex 首发 + completed + 重启 resume 通过，2 次 HTTP 请求 |
| `bun scripts/official-claude-smoke.ts` | 真实官方 Claude SDK 首发 + result + 重启 resume 通过，3 次 HTTP 请求 |

两份 smoke 均验证所选模型和鉴权请求头、密钥不进入请求正文，以及恢复后的请求包含前后两轮用户消息。使用 fake key、回环 HTTP 和隔离临时目录；没有测试公司网关、真实推理质量或真实工具执行。Claude SDK 可能先发送模型校验请求，因此不能把 HTTP 请求序号当作用户轮次。

验收中真实发现并修复：Codex Windows 深目录导致 SQLite 初始化失败；进程树退出与文件锁清理；Claude 适配器实例间会话污染、消费方提前结束时未回收 SDK、旧 query 尾声误删新 entry；stderr 分块密钥脱敏；Codex `completed` 成功终态误判。Claude 首次 smoke 的模型不可用报错和随后文本序号断言失败还涉及测试服务未接纳 `/messages` 的 query string、把模型预检计为正式轮次，已修正 fixture 后重跑通过。

构建仍有已有的大 chunk/混合导入提示；未生成安装包，未提交或清理用户原有工作树改动。不是全量测试套件通过声明；前期报告中其他无进展治理问题未在此认领修复。

早期失败 smoke 的 4 个测试目录残留于系统 TEMP（`tagent-official-claude-cwd-7Z5QY7`、`tagent-official-claude-cwd-Y4wGJJ`、`tagent-official-claude-smoke-PHCHil`、`tagent-official-claude-smoke-zGOhTf`）；显式限定路径的清理仍被执行策略拒绝，未绕过。它们是本地伪凭据测试数据，不是用户会话；最终两次成功 smoke 正常退出并清理自身目录。

## 下一步

本地停止传输释放已复核并修复 Codex 路径；接下来补配置的公司 API 渠道桌面验收：完整 Pi 循环、全应用重开、真实工具与审批、停止后续聊/换核、错误与两两接力。官方 Codex/Luna、Claude/已有 DeepSeek 的文本与原生进程恢复及本地控制面 smoke 已实测通过，不能替代上述门槛。通过后再进入 B：交接失败/结果不明的恢复入口与目标容量管理，最后进入 C 的并行协作。不要因文本 smoke 通过直接开放多 Agent 并行写工作区。
