# Claude / Codex 稳定性验证

日期：2026-10-19。承接 Pi 稳定性修改，本次检查官方 Claude Agent SDK 与 Codex App Server 两条适配链路。保留现有工作区修改，未提交 commit，未重启用户 Electron。

## 确认并修复的问题

### Claude

已安装 SDK 0.3.185 的类型区分 `stream_event`（部分输出）与 `assistant`（交付消息）。TAgent 旧转换器仅凭 `stop_reason` 是否为空判断完成，可能把完整 assistant 当成草稿。现在官方适配器为完整 assistant 附加 `_contentSnapshot`，转换器在缺少 stop_reason 时使用本地 `message_complete` 标记；该标记表示消息完成，不表示整轮结束。轮结束仍由 result 决定。旧 KSCC 消息不自动套用此规则。

快照不再进入旧的派生 delta/剥空正文路径。该标记随原始 SDK 消息持久化，历史与实时采用相同解释。补充了 SDK 字符串错误类型和 result.errors 的透传，避免丢掉失败原因。

### Codex

原适配器把 item delta 交给全会话文本缓冲，而 item/completed 没有生成前端所需的消息完成标记。工具完成后迟到的 started 也可能重新把它置为 streaming。

现在按 itemId 累积正文和思考，发送完整快照；item/completed 明确结束该消息。思考摘要和原始思考分别按索引累积，有摘要时使用摘要，不重复拼接两份内容。终态时接受合法的更短正文或空内容，不保留旧草稿。

收到 turn/completed 时，尚未收到 item/completed 的文字快照先以该轮终态收尾并交给持久化路径，再发 result。完成 item/turn 保留有界的迟到事件记录，避免重复落盘和复活。该兜底依赖 turn/completed 到达，不等同于异常进程退出时的恢复保证。

正文快照按 50ms 合并发送，工具和终态事件不等待计时器；销毁会话时取消待发快照。避免高频完整快照给 IPC 和界面增加不必要负担。

### 共用显示层

子代理消息使用与主线相同的 UUID 更新和终态保护。界面显式区分 Codex 的 interrupted、failed 与完成，防止未附带错误文本的失败/中断落入成功分支。

## 验证范围与结果

| 验证层次 | 结果 | 范围 |
| --- | --- | --- |
| Claude/Codex 专项自动测试 | 18 文件、158 项通过 | 事件转换、适配器、权限/请求输入、会话管理、持久化闸口、历史回放、显示模型、快照合并 |
| 实际安装内核 + 本地 HTTP | 1 文件、2 项通过 | 启动真实 Claude SDK/子进程和 Codex App Server；各连续两轮发送、流式输出、终态内容、不同消息身份 |
| Pi 与共用界面既有回归 | 25 文件、308 项通过 | 前序流式、标点、子代理预算、Pi HTTP 回放等 |
| 类型与构建 | 通过 | Electron/shared 类型检查，Electron 主进程与 renderer 构建，git diff --check |

合计 468 项通过。普通专项命令默认跳过两项需要本机可执行程序的测试，已另外显式开启执行；不是把 skipped 计为通过。本机 Codex 版本为 0.151.0，Claude Agent SDK 为 0.3.185。Renderer 仍有大 chunk 和静态/动态混合导入警告。

回放用例使用合成协议事件，实际经过生产转换器、持久化闸口（Claude）、消息 reducer、JSON 序列化和展示模型；它们没有挂载整个 Chat/Electron 或调用实际会话磁盘服务。Claude 回放的 SDK generator 被替换；真实进程测试独立验证正常连续两轮，不混淆这两层证据。

真实进程测试使用临时目录、隔离 runtime home、虚拟密钥和 loopback HTTP，没有请求用户模型渠道，也没有运行仓库调查工具。首次运行遇到 Windows 子进程退出前同步删除临时目录失败；测试清理改为异步等待重试后通过，不涉及修改用户运行目录。

首次失败测试留下的 `tagent-native-wire-BlDbwt` 临时目录另行清理时被自动审批策略拒绝（仅返回 blocked by policy），已保留；后续成功测试各自的异步清理通过。

## 重复执行

```powershell
bun run test:agent-stability
bun run test:kernel-stability

# 需要本机已安装相应运行时；仍只调用本地测试 HTTP 服务
$env:TAGENT_TEST_NATIVE_RUNTIMES = '1'
bunx vitest run native-runtime-wire.test.ts
Remove-Item Env:TAGENT_TEST_NATIVE_RUNTIMES
```

## 尚未验证

- 用户真实网关和模型的生成质量、长时间连接及限流行为。
- 完整 Electron 中的滚动、长 Markdown 绘制性能与主观流畅度。
- 真实模型驱动的多个 Claude/Codex 子代理并行工作；目前覆盖的是任务事件和适配器行为，没有移植 Pi 的子代理预算策略。
- 实际内核中途断网/进程崩溃、跨重启恢复，以及真实运行期间停止后的所有竞态。部分停止/恢复和迟到事件由受控适配器或回放测试覆盖，不代表所有真实场景已验收。

因此本次结论是：两种内核已补上专项验证，并修复了确认的 TAgent 适配缺陷；不能宣称三核所有功能已经全面稳定。使用修复需加载新主进程和 renderer。
