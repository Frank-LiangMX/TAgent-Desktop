# 官方 API 路径实机验收 — 2026-09-17

状态：真实文本/恢复路径部分通过，不作为发布通过声明。承接 [实施与验收](official-api-implementation.md)，与此前使用旧账号/KSCC 的验收分开记录。

后续更新：本页保留首次验收证据。正确 Node 观察端已确认 Claude 停止误报、修复官方 Codex 取消后的连接回收，并通过两内核工具/停止续聊共 6 个场景；最新结论见 [停止与续聊验收](official-runtime-stop-acceptance-2026-09-17.md)。桌面端到端等门槛仍未完成。

## 隔离方法

- `scripts/official-runtime-live.cjs` 使用当前开发依赖的 Electron；读取指定渠道，复制指定 Chromium profile 的 `Local State` 到新临时目录后同机解密。不复制正式聊天，不修改源渠道或账号设置。
- 解密后的密钥只留在内存，通过 stdin 交给 Bun worker，不写参数、报告或配置。解密失败即停止，不尝试明文降级。初期选错 profile 的三次启动均在发请求前退出；匹配的 profile 为 `@tagent/electron`。
- HTTP 探测只发送虚构短口令，没有工具或项目资料；每次请求超时 60 秒，禁止重定向。临时工作区与运行目录不指向真实项目。
- 报告只保存协议、HTTP 状态、格式/口令校验布尔值和耗时。测试目录保留以便复核，含复制的系统加密状态，应按敏感临时数据处理，不能公开上传。
- HTTP 探测不等于 Agent 完整运行；适配器运行不等于宿主 IPC、聊天落盘与桌面 UI 端到端通过。

## 配置地址的真实协议探测

渠道：已启用的 `seasun`。仅使用原本已启用模型。真实渠道 `apiProtocol` 未显式配置，仍按旧 custom 渠道走 Chat；没有自动替用户改为 Responses。

| 地址上的协议 | 模型 | 结果 | 耗时 |
| --- | --- | --- | --- |
| Chat Completions | grok-4.6 | HTTP 200，响应格式及 `API_OK` 校验通过 | 1.57 秒 |
| Responses | gpt-5.6-luna | HTTP 200，响应格式及 `API_OK` 校验通过 | 38.91 秒 |
| Messages | gpt-5.6-luna | HTTP 404 | 0.05 秒 |

原始脱敏报告目录：`%TEMP%/tagent-api-live-Sy1Fez/report.json`。

该结果只覆盖**所配置地址 + 指定模型 + 本次请求格式**。404 不证明同一供应商所有地址都不支持 Messages，也不是密钥无效或 Claude 内核缺陷的证据。两次成功耗时不能用于推断模型质量、长期延迟或算力稳定性。

## 真实内核与客户端结果

由主代理审阅并修正 worker 后执行；未使用子代理自述代替实际运行。第一轮要求记住随机 UUID 代号与 `NO_WRITE` 约束，第二轮不重述答案，仅问先前两个代码。校验只取 assistant 可见文本，拼接流式片段，必须精确命中两者并收到无错误的成功终态。

| 路径 | 结果 | 两轮合计 | 脱敏报告目录（TEMP 下） |
| --- | --- | --- | --- |
| 官方 Codex + seasun / gpt-5.6-luna | 首发、销毁原生进程、新 adapter 以原生 thread ID 恢复、精确回忆通过 | 7.79 秒 | `tagent-api-live-QFBk0N` |
| 官方 Claude Code + 开发配置中已启用 DeepSeek / deepseek-v4-flash | 首发、销毁原生进程、新 adapter 以原生 session ID 恢复、精确回忆通过 | 7.68 秒 | `tagent-api-live-iqRZ7B` |
| Pi 实际 HTTP 客户端 + seasun / grok-4.6 | 首发、携带真实第一轮 assistant 历史的第二轮回忆通过 | 17.03 秒 | `tagent-api-live-pYrJBB` |

Codex/Claude 使用官方适配器和真实可执行文件，凭据由指定 API 渠道提供，没有走 `codex-internal` 或 KSCC。Claude 测试读取已有开发渠道，没有启用正式配置里被禁用的渠道，也未宣称 seasun 的 Messages 404 已解决。

Pi 此项明确只测试生产 HTTP streamFn，不含 Pi Agent 全循环、宿主落盘或重启恢复。原生内核项是进程销毁后重建，不是整个桌面应用重开。工具策略分别为 Codex read-only sandbox（不保证禁用所有原生只读工具）、Claude 对交给宿主的工具请求拒绝、Pi HTTP 无工具；这批请求没有要求执行工具，不能充当工具/审批验收。

## 待完成门槛

公司网关工具流；完整 Pi 循环；桌面入口、全应用重启与全部两两接力；长上下文与异常交接恢复。本地工具/审批/停止的后续结果见上述独立报告；没有覆盖的项目不得以文本探测替代。

## 本地工具控制与停止：首次验收历史（后续已复核）

脚本：`scripts/official-runtime-controls-smoke.ts`。主代理独立运行真实官方可执行文件、回环 SSE、伪凭据与临时只读文件：

- Codex Dynamic Tool 桥：允许时实际读取 fixture，拒绝时返回宿主拒绝信息；两者均检查第二次 Responses 请求携带相应工具结果，并收到 `completed`。**这不是原生 Shell/写工具审批测试。**
- Claude Code 原生 Read：允许/拒绝回调均实际触发；第二次 Messages 请求分别携带文件内容/拒绝信息，并收到无错误 `success`。
- Codex 挂起 Responses 后 `interruptQuery()`：收到 `interrupted` 终态，但 6 秒内没有观察到 HTTP response/socket 关闭。Bun 和临时编译为 Node 执行均复现。不能据此说“用户停止无效”，但“停止后传输释放”门槛尚未通过。
- Claude 挂起 Messages 后 interrupt：6 秒内没有观察到流关闭；当前记录未充分证明取消终态，仍未通过。Node 编译版 Claude 没有进入原生请求，不能拿它作 Claude 的 Node 等价验证。

本期保留失败门槛，没有为了让测试绿而修改产品停止语义。下一项优先排查：取消终态、在飞请求释放、宽限期后进程回收和停止后新回合/换核的关系；不可把“停止 ACK”当作资源已释放，也不能在不明状态自动重放任务。

夹具修正与产品缺陷分开记录：Claude `/v1/messages` query string、模型预检与正式请求的区分、文本/tool-input SSE 增量完整性，以及不能用 HTTP incoming request `close` 当作响应取消证据。早期“Claude 没有发 HTTP”的说法仅是旧计数器未接纳请求，已由路由观测纠正。

当前复现命令（PowerShell；停止测试不得使用 Bun 作为 HTTP 关闭观察端）：

```powershell
$env:TAGENT_CONTROLS_MODE='tools'
node scripts/run-official-runtime-controls.mjs

$env:TAGENT_CONTROLS_MODE='interrupt'
$env:TAGENT_CONTROLS_RUNTIME='codex' # 改为 claude 可单独验证
node scripts/run-official-runtime-controls.mjs
```

脚本作用域不依赖真实渠道。仅 tools 用例通过不代表默认完整 smoke 通过。一次并行诊断出现测试目录 `tagent-official-controls-h4E8xT` 的 EBUSY 清理失败；未清理用户数据，临时 Node 构建文件已移除，可随时重新生成。

## 本轮基础回归

独立执行 6 文件、110 项聚焦测试通过：Codex / Claude adapters、runtime-api-connection、runtime-switch、真实 IPC handler 的 session-service.runtime-switch，以及共享 runtime-channel 规则。此处 IPC 的网络/内核仍使用测试替身，不与真实模型验收混算。

根目录 `bun run typecheck` 全工作区通过；新增独立脚本不在该 tsconfig 检查范围内，另经直接运行验证。launcher 通过 `node --check`；worker 无效输入测试返回脱敏失败及非零退出码。

另新增并通过 11 项 worker 判定回归：拼接 assistant delta、排除用户回显/思考、精确代码匹配、成功终态不可缺失、错误标志不可伪报成功，以及拒绝非隔离目录。共计本轮 121 项逻辑测试通过，不包含烟测计数。

当前一个渠道记录只保存一种 `apiProtocol`。测试地址同时支持 Chat/Responses，不代表应静默把整个正式渠道切为 Responses：同一渠道下的其他模型未逐一验证。真实绑定验收在隔离输入里选择协议，正式配置不变；后续配置体验应明确“内核兼容”和“模型能力实测”两个层次。
