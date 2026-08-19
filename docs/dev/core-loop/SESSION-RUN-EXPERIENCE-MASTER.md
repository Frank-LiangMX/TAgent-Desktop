# 会话运行体验 · 总览（2026-08-18）

> 触发：打包版 `session-1786959659981`（TAgent-Desktop / collab room）+ `session-1787014972010`（贴图统计）落盘审计。  
> 用户原话：运行中「停一下再继续」、计时从 0 重来；Plan Mode 只在消息里说一句、不切 TAgent 计划模式、不给用户审计划；「接着开发」却长篇探索不像在干活。

## 1. 一句话

**同一条用户发送 → 真正结束** 期间，产品应：**计时连续、运行态不抖、Plan 有人审、选项能点、别自动替你批准、别把续聊摘要当用户消息。

## 2. 工作包与优先级

| ID | 工作包 | 规格 | 状态 | 优先级 |
|----|--------|------|------|--------|
| **RT** | 运行计时跨工具等待 | [RUN-TIMER-ACROSS-TOOL-WAIT-SPEC.md](./RUN-TIMER-ACROSS-TOOL-WAIT-SPEC.md) | **代码已合，待打包验证** | P0 |
| **PM** | Plan Mode 产品闭环 | [PLAN-MODE-CLOSURE-SPEC.md](./PLAN-MODE-CLOSURE-SPEC.md) | 未实现 | P0 |
| **UX** | AskUser / 续聊 / 耗时碎片 | [SESSION-UX-RESIDUAL-SPEC.md](./SESSION-UX-RESIDUAL-SPEC.md) | 部分（AskUser Banner 已有） | P1 |
| **DP** | Work 调度与「接着干」 | [SESSION-DISPATCH-POLICY-SPEC.md](./SESSION-DISPATCH-POLICY-SPEC.md) | 未实现（prompt 层） | P1 |
| **SA** | 子代理完成时刻 | UX 规格 §4 + RUN-TIMER 看门狗 | 部分 | P2 |

### 依赖

```
RT（计时）──► 打包验证
PM（Plan）── 独立，可与 RT 并行；不依赖 RT
UX（AskUser 关窗等）── 部分依赖 REGRESS-H（Banner 已合）
DP（prompt）── 可与 PM 并行，不挡 PM 实现
```

### 建议落地顺序

1. **RT** 打包实机：长 Bash / 子代理 / 无子代理工具间隙，pill 单调增加。  
2. **PM** 搬 General：`EnterPlanMode` 切态 + `ExitPlanMode` 审批横幅 + 禁止 bypass 自动批准。  
3. **UX** 关窗≠整轮停止、续聊摘要不进主线、`turnDurations` 按整轮记一条。  
4. **DP** Work prompt：「接着开发」默认开写，大范围才 Plan；Plan 内限 Explore 数量。  
5. **SA** 子代理卡片耗时用 parented 末条时刻，不用 stub tool_result。

## 3. 审计证据（只读）

| 会话 | 文档 | 结论摘要 |
|------|------|----------|
| `session-1786959659981` TAgent-Desktop | [AUDIT-packaged-tagent-desktop-prev-session-FINDINGS.md](./AUDIT-packaged-tagent-desktop-prev-session-FINDINGS.md) | 42 次 >5s 空窗致计时归零；5 次子代理最长 218s；EnterPlanMode 无 UI；ExitPlanMode 自动批准 |
| `session-1787014972010` 贴图统计 | [AUDIT-packaged-latest-run-timer-FINDINGS.md](./AUDIT-packaged-latest-run-timer-FINDINGS.md) | 无子代理也停；14+10 次 >5s 工具间隙 |

## 4. 对照仓库（实现时必读）

| 能力 | TAgent_General（真源） | TAgent-Desktop（现状） |
|------|------------------------|------------------------|
| ExitPlanMode 审批 | `agent-exit-plan-service.ts` + `ExitPlanModeBanner.tsx` + `useGlobalAgentListeners` | 类型 stub  only，`permission-service` 不拦截 |
| EnterPlanMode 切态 | `agent-orchestrator.ts` `emitPlanModeChanged` + `plan_mode_changed` | 无 |
| AskUserQuestion | `agent-ask-user-service.ts` + Banner | `AskUserQuestionBanner` 已合（REGRESS-H） |
| 权限档 plan | `TAGENT_PERMISSION_MODE_CONFIG.plan` =「计划模式」 | 有 UI pill，**与 SDK EnterPlanMode 未联动** |

## 5. 本轮明确不做

- 改 Pi / KSCC 工具循环内核（`turn_end` 仍会来，只在 UI 层正确处理）。  
- 重写 MoA / 协作室业务功能本身（collab room 开发内容另开）。  
- glm `stop_reason` 落盘修复（模型/适配器，优先级低于上述）。  
- 在本 MASTER 里直接改代码；各子规格 + brief 派 kscc 执行。

## 6. 验收（发版前手测清单）

- [ ] 一轮内多次 Read/Bash >10s：composer 计时 pill **不跳 0**。  
- [ ] 派 Agent 等 60s+：pill **不跳 0**，停止键不因 turn_end 闪没。  
- [ ] Agent 调 `EnterPlanMode`：composer 显示 **计划模式**，非仅气泡文案。  
- [ ] Agent 调 `ExitPlanMode`：弹出 **计划正文 + 批准/拒绝/意见**，未点批准 **不能开写**。  
- [ ] `bypassPermissions` 下 ExitPlanMode **仍等人**，不出现 SDK 自动 "User has approved"。  
- [ ] AskUser 关窗：会话 **不记 stopped**，可继续。  
- [ ] 续聊摘要 **不进**用户气泡列。  
- [ ] 用户说「接着开发」：默认 **短确认 + 开写**，不自动 EnterPlanMode 长探索（prompt 验收，可主观）。
