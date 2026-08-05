# TAgent 基础可用性审计总览（对照 Proma Pi 核）

> 日期：2026-08-05  
> 方法：4 路 `kscc -p --model sonnet` 并行只读审计 + 人工复核用户最新会话证据  
> 对照：`F:\Proma`（可干活基线）vs `F:\TAgent-Desktop`  
> 分报告：`01-permission-tools.md` / `02-pi-runtime-stream.md` / `03-renderer-ux-state.md` / `04-release-blockers.md`

---

## 一句话

**会话「能跑」，但默认策略 + 权限协议 + 终态收束 三处基础缺陷，叠在一起就会表现为「一干活全是权限问题 / 状态卡死 / 错误不收敛」——这不是小体验问题，是发版给普通用户做基本使用的阻断。**

用户最新会话（`Downloads/session-1785899943685`）证据：多次  
`Tool permission request failed: ZodError … updatedInput expected record, received undefined`  
（Bash / Write），模型在流里都在承认 harness 权限层 bug。

---

## 发版能否？

| 场景 | 结论 |
|------|------|
| **对外公开发版** | **否**。产物层 ADR「对外不装 kscc」未落地（`04` P0-1）；基础干活链路仍有未合入/未验证修复。 |
| **内测小圈（懂 Chat/Work、能容忍弹窗）** | **谨慎可**，但必须先合入权限 `updatedInput` + 重启 main，并写清已知坑。 |
| **「让用户基本当 coding agent 用」** | **否**。默认 Chat + auto 权限 = 写文件被硬拦或狂弹窗；横幅/超时/无 RESOLVED 仍脆。 |

---

## P0 阻断（先修这 6 条，否则别谈发版测「基本干活」）

| # | 问题 | 证据/路径 | 状态 |
|---|------|-----------|------|
| **1** | **kscc `canUseTool` allow 缺 `updatedInput` → Zod 整次失败** | 用户会话 15× ZodError；Proma `allow()` 恒带 `updatedInput:input` | **工作树已修未提交**（`permission-service.ts` / kanban-worker） |
| **2** | **默认 `executionMode=chat` 硬拦写操作** | `session-store` 默认 chat；`isChatModeBlockedTool` 先于 bypass | 未修；产品默认即「不能干活」 |
| **3** | **默认权限档 `auto`：每个写/非只读 Bash 都弹窗** | Proma 默认 bypass；TAgent 默认 auto | 未修；与 2 叠加 |
| **4** | **权限横幅单槽 + 30s 超时自动 deny + 无 PERMISSION_RESOLVED** | 超时后 banner 死、按钮空操作；切会话丢 pending | 未修 |
| **5** | **Pi 错误 turn 双 `result` + error 无 `errors` 被当成功** | `pi-agent-adapter` message_end + agent_end | 未修；状态/记忆双 turn_end |
| **6** | **对外产物仍含 kscc/`claude.exe`** | ADR-0001 无构建排除开关 | 未修（对外版合规/体积） |

---

## P1（严重影响可用，内测也痛）

| # | 问题 |
|---|------|
| Pi 无 turn 级 retry；崩溃恢复 Pi 核 resumeId 空 → 直接 error | 
| 停止依赖 prompt 抛错副作用，可能卡 running | 
| 流式 tool 卡片双发；`stop_reason:null` 模型依赖 turn_end 兜底 | 
| 中断/断流无 idle 兜底 reconcile → 计时/停止键卡死 | 
| 错误是扁平气泡，无 copy/retry | 
| Pi 子代理裸 `Agent` 无 `beforeToolCall`（安全+一致性） | 
| 工具实现体量远小于 Proma（pi-builtin-tools ~50KB vs TAgent tools ~12KB） | 
| Windows 本地 `package:win` 未串 native rebuild；kscc `.cmd` spawn 风险 | 

---

## 架构层对照（为什么「对照 Proma Pi」差这么多）

| 维度 | Proma | TAgent-Desktop |
|------|-------|----------------|
| Pi 运行时 | `@earendil-works/pi-coding-agent` **AgentSession**（retry/overflow/终态门控） | 裸 `@earendil-works/pi-agent-core` **Agent** |
| 权限 | 单一路径 + allow 必带 `updatedInput`；默认 bypass | Electron 服务 + 空壳 pi-core 权限并存；默认 auto+chat |
| 工具层 | 厚封装 bash/wsl/wrapPermission | 薄 defaultTools |
| 权限 UI | 全局 atom 队列 + resolved 事件 | Chat 内单槽 state |
| 长驻/steer | 真软中断 + 队列 | Pi 每轮 result 后 closed，steer 近死代码 |

**结论**：不是「差几个 bug」，是 **运行时语义层（AgentSession）+ 默认产品策略 + 权限协议** 三层都比 Proma 薄/反。短期补丁可过内测；要对齐「基本 coding agent」需按序修 P0，并评估是否升 `AgentSession`。

---

## 建议修复冲刺（给发版/内测）

### Sprint A — 48h 内「能写文件、权限不炸」（必做）

1. **提交并验证** `updatedInput` 修复（已有 diff）— 用 Bash/Write 回归  
2. **新会话默认 `work` + 默认权限 `bypassPermissions`**（或至少默认 work + auto 可接受弹窗）  
3. **PERMISSION_RESOLVED + 横幅队列化**（或先去掉 30s 硬超时、超时清 banner）  
4. 重启 main 验证用户同款操作路径  

### Sprint B — 一周内「不卡死、错误可读」

5. Pi 统一 result 出口（删 message_end error result）  
6. interrupt 显式 turn_end；idle 兜底清 running  
7. 错误条 + 重试  
8. 子代理挂 beforeToolCall  

### Sprint C — 对外版

9. 对外构建排除 kscc/SDK 二进制  
10. package:win 串 rebuild:native；Windows spawn 实测  

---

## 分报告索引

| 文件 | 焦点 | 产出方 |
|------|------|--------|
| [01-permission-tools.md](./01-permission-tools.md) | 权限/默认策略/子代理裸奔 | kscc agent A |
| [02-pi-runtime-stream.md](./02-pi-runtime-stream.md) | Pi 流式/终态/retry/停止 | kscc agent B |
| [03-renderer-ux-state.md](./03-renderer-ux-state.md) | 横幅/running 卡死/错误 UI | kscc agent C |
| [04-release-blockers.md](./04-release-blockers.md) | 发版产物/双核/看板等缺口 | kscc agent D |

---

## 已修但未闭环（勿当「用户已修好」）

- 权限 `updatedInput`：工作区已改，**需 commit + 用户进程重启 + 回归**  
- 侧栏层级/折叠/文件夹图标：UI 项，与干活主链无关  
- 运行计时跨会话、侧栏切会话：已修部分，仍缺 idle 看门狗（见 03）

---

## 子代理修复批次（2026-08-05）

### 批次 1 — Sprint A + 部分 B
| 代理 | 落地 |
|------|------|
| A 默认策略 | 新会话默认 `work` + `bypassPermissions` |
| B 权限横幅 | `PERMISSION_RESOLVED` + per-session 队列 + 超时 120s 清横幅 |
| C Pi 终态 | 唯一 result 出口；STOP 补 turn_end |
| D 子代理/idle | 子 Agent 挂 beforeToolCall；remount idle hard-stop |

### 批次 2 — 自研补齐原 backlog（禁止抄 Proma）
| 代理 | 落地 |
|------|------|
| Pi 稳定 | turn 级重试 3 次 + maxTurns=50 + toolcall_end 不再双发 |
| 错误 UI | SessionErrorBanner + 复制/关闭/可重试 |
| STOP/steer | Pi steer→pending 下轮发送；STOP 清 pending+turn_end |
| 构建 | package:win 串 rebuild；`TAGENT_EXTERNAL` / package:win:external |
| kscc+Google | Windows .cmd→cmd.exe；Google 真 generateContent 探测 |
| 流式 uuid | assistant.uuid 贯通 stream/落盘就地更新 |

### 仍可选/未做
- MoA 会诊接线、子代理过程持久化/实时进度条
- @ 多角色群聊时间线、默认 skills 捆绑
- 升到 pi-coding-agent AgentSession（大重构，有意不做）
- 完整 package:win 全量出包实测
