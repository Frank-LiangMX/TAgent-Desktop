# TAgent 与本地 Hermes / Ekko Studio 的对照

> 范围纠正：用户本次要参考的是协作室的后续开发。本文主要讨论普通聊天稳定性，不能作为本次协作室需求的主要结论。对应的协作室专项分析见 [协作室后续开发对照](./2026-10-19-collaboration-room-hermes-roadmap.md)。

日期：2026-10-19。参考目录 `F:\hermes-studio`，其 package.json 当前标识为 Ekko Studio 0.7.37。此次为源码和测试代码静态检查，没有安装依赖、运行参考项目测试或验证实际模型渠道；没有修改参考项目和 TAgent 产品代码。

## 结论

当前证据不足以支持替换 TAgent 整个框架。更有价值的是借鉴参考项目在消息持久化、会话恢复、工具预览和配置归属方面的明确边界。TAgent 已有统一 IR、三核适配器、历史恢复及本轮快照修复，应在这些基础上继续收敛行为，而非重新搭建另一套聊天链路。

参考项目的接入数量、README 演示截图和测试文件数量都不等于真实环境稳定性。其 README 截图使用演示数据；部分测试直接模拟处理函数，不能替代生产链路验证。

## 已核对的参考实现

### 1. 统一消息持久化，内核只决定写入时机

`F:\hermes-studio\packages\server\src\modules\studio\services\chat-run\message-persistence.ts:32` 的 `persistRunMessages` 被设计为 Bridge、Ekko 和 Responses coding agents 的公共存储逻辑，统一 runMarker、正文、reasoning、工具关联及数据库 ID。适配器仍决定何时写入，例如等待并行工具组完整结束。

TAgent 的 `apps/electron/src/main/lib/ipc/session-service.ts:3419` 已明确区分 Claude SDK 原生恢复记录和 Pi 面板 IR，不能粗暴合并这些格式。适合进一步统一的是面向界面的消息身份、轮次归属和终态解释，保留各内核自己的上下文恢复要求。

### 2. 恢复协议返回消息和运行状态

参考 `packages/client/src/api/studio/chat.ts:935`、`:959` 和 `packages/client/src/stores/hermes/chat.ts:3935`：临时断线不会立即结束任务，重新连接后请求 resume，按服务端消息、isWorking、队列和中止状态恢复界面；store 校验会话和运行环境 generation，降低过期回调污染当前界面的风险。

这不代表其恢复实现没有竞态，也不等于主进程崩溃后的完整恢复保证。TAgent 已有恢复代码和测试，下一步应检验三核在刷新、切换会话、进程退出、停止后重试时是否遵守同一套显示规则，不能凭这次抽查认定它没有恢复机制。

### 3. 工具预览与完整数据分离

参考 `packages/server/src/modules/studio/services/chat-run/resume-payload.ts`：默认恢复页为 150 条，工具结果显示预览上限为 1000 字符，特殊内容有例外；处理的是克隆后的出站显示数据，完整持久化和运行上下文保留。

TAgent 可采用相同原则：聊天中默认显示工具名、状态和短摘要，原始日志按需展开或分页读取。不要截断 Agent 后续需要的工具结果，也不要把工具日志包装成普通回复或思考。具体阈值需按 TAgent 的组件及实际负载确定，不应直接照搬数字。

### 4. 配置与权限有明确归属

参考 `packages/client/src/views/hermes/SettingsView.vue:31`：账户、显示、代理、压缩、隐私、模型分别组织，用户管理和 webhook 标签按管理员身份显示，旧 Agent 配置入口跳转至专门页面。

`packages/server/src/modules/studio/sockets/chat-run.ts:722` 还有真实的服务端 token、分享访问和 profile 访问校验。鉴权可关闭，因此这里不能推导为所有部署默认安全，也没有在本轮完成权限安全审计。

TAgent 的 `SettingsPage.tsx:1292` 将 `FusionRoomNetworkSettings` 直接放在关于页；该组件第 220 行还明确提示真实账户认证尚未完成。建议移到“高级 → 实验性协作”，默认折叠；关于页保留版本、更新及许可证等产品信息。这个调整改善入口组织，不会自动补全协作认证。

跨设备协作与本机子代理执行是不同功能。不能为了使用本机多代理而要求用户开启网络协作设置。

### 5. 能力声明与界面测试

参考 `packages/server/src/modules/coding-agents/contracts/definition.ts` 定义 images、nativeCompact、modes 等能力字段。TAgent 可据此思路核对自己的能力声明，让识图、压缩和执行模式的入口与运行时实际支持一致。模型是否支持图片还必须检查具体模型及所选渠道，不能只看内核能力。

参考 `tests/e2e/chat-streaming.spec.ts` 使用真实浏览器界面和模拟 Socket.IO 事件检查流式文字、停止按钮、思考与工具位置及布局。它覆盖了界面层，但不证明真实后端、网关和模型都正常。

TAgent 前轮已完成生产转换器、状态归并、历史回放以及真实 Claude/Codex 进程配本地 HTTP 的验证。当前更需要补实际 Electron 界面和真实渠道的验收，不能只继续增加类似的转换器单测。

## 不宜直接照搬的部分

- `response-stream.ts:42` 仍按前缀和至少 16 字符的首尾重叠推测文字增量。TAgent 本轮已明确增量和完整快照语义，应继续维护该契约，避免引入另一套文本猜测。
- 参考项目的聊天 store 和 socket 入口仍集中大量逻辑；目录结构整齐不意味着复杂度已消除。
- `tests/server/chat-run-message-flush.test.ts:81` 明确采用模拟处理函数。应优先测试生产函数和完整链路，避免测试中的副本正确、实际代码错误。
- `docs/native-coding-agents.md:38` 提出代理网关只统计 usage、原生运行时负责聊天和工具生命周期。这是值得采用的职责原则，但本轮没有逐个审计其所有内核是否完整遵守。

## 建议下一轮顺序与验收

| 优先级 | 工作 | 可验收结果 |
| --- | --- | --- |
| P0 | 在实际 Electron 中验收 Pi、Claude、Codex 的消息生命周期 | 每核覆盖连续对话、工具前后输出、停止后重试、会话切换、刷新和进程异常；正文不串到思考，终态不被迟到事件复活，恢复后无重复或无解释的丢失 |
| P0 | 按上述故障收敛恢复与持久化路径 | 相同事件序列在实时展示与历史恢复中得到相同的消息身份、内容及任务状态；区分消息完成和整轮完成 |
| P1 | 工具内容渐进展示，整理实验功能入口 | 常规聊天不被原始日志占满，完整输出可查看；关于页不展示网络监听和证书调试控件 |
| P1 | 增加流式链路观测 | 对同一轮记录上游到包、主进程归并、IPC 发送、界面显示时刻及积压量，区分渠道停发与本地渲染卡顿 |
| P2 | 核对能力声明并单独推进网络协作 | 三核入口匹配实际能力；网络协作按认证、授权、撤销、重连的独立验收结果决定可见性与成熟度 |

“丝滑”不能仅靠固定打字动画：上游数秒没有数据时，本地只能平滑已收到的内容。先测量时间线，再决定调整渠道、IPC 批次、渲染开销还是显示缓冲；避免加大缓冲后看似匀速、实际答案更晚显示。

这份顺序是后续开发建议，本次没有执行这些产品修改或新增验证。前轮验证范围和限制仍以 `2026-10-19-agent-stability-iteration.md`、`2026-10-19-claude-codex-stability-validation.md` 为准。
