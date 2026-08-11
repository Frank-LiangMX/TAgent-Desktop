# Brief：实现主会话无进展防循环（No-Progress Guard）

> 日期：2026-08-11  
> 规格真源：`docs/dev/core-loop/NO-PROGRESS-GUARD-SPEC.md`（全文照做）  
> 执行：本地 `kscc / glm-5.2`  
> 状态：待实现

## 目标

在 `maxTurns=50` 撞墙之前拦截「重复无进展」工具循环：策略复盘 → 仍重复则 `paused_no_progress` 暂停等用户；`maxTurns=50` 只作最终保险丝，不调大、不删除。

背景案例：UnrealTagManager `session-1786349874458` 同一失败策略撞到 `error_max_turns`，UI 显示笼统「运行出错」。

## 必做（以 SPEC 为准）

1. 按 SPEC 实现守卫状态机、指纹/重复判定、复盘注入、pause 终态与 KSCC/Pi 双核接线。
2. `error_max_turns` / `paused_no_progress` 分类与 UI 文案按 SPEC（勿把 pause 当崩溃 error）。
3. 单测覆盖 SPEC 所列场景；`git diff --check`；相关 vitest 通过。
4. 输出 `docs/dev/core-loop/NO-PROGRESS-GUARD-FINDINGS.md`（改动文件、验证、未做项、风险）。
5. **不 commit / 不 push**（本轮只改代码+文档）。

## 硬约束

- 不调大 `maxTurns` 冒充修复。
- 静默/更新路径无关则勿动。
- 不顺手重构流式管线 / 安装器 / 无关 UX。

## 验收

对照 SPEC §验收 / §测试：重复失败在 50 轮前 pause；真正有进展不误杀；`maxTurns=50` 仍兜底；FINDINGS 完整。
