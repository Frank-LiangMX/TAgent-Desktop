# 记忆系统文档（`docs/memory/`）

双核上下文管理 + 全局 L0–L5 记忆。正式文档在此目录；`.context/` 仅保留 agent 会话临时稿（git 忽略）。

## 阅读顺序

1. **[handoff.md](./handoff.md)** — 现状、完成清单、验证命令、后续增强  
2. **[master-design.md](./master-design.md)** — 总览、决策表 D1–D11、架构  
3. 分阶段实现说明：  
   - [phase-1-data-foundation.md](./phase-1-data-foundation.md)  
   - [phase-2-global-l5-port.md](./phase-2-global-l5-port.md)  
   - [phase-3-pi-8k-coordinator.md](./phase-3-pi-8k-coordinator.md)  
   - [phase-4-kscc-soft-reset.md](./phase-4-kscc-soft-reset.md)  
   - [phase-5-polish.md](./phase-5-polish.md)  
4. **[archive/](./archive/)** — 开发期 brief / 移植结果（可定期清理）

## 与代码的对应

| 区域 | 路径 |
|------|------|
| 记忆服务 | `apps/electron/src/main/lib/memory/` |
| IPC | `apps/electron/src/main/lib/ipc/memory-service.ts` |
| kscc 软重置 | `apps/electron/src/main/lib/agent/kscc-soft-reset.ts` |
| pi 8k 协调器 | `packages/pi-core/src/session-memory-coordinator.ts` |
| 记忆 UI | `apps/electron/src/renderer/components/memory/` |

## 迁移说明（2026-08-01）

| 原路径（`.context/`，已忽略） | 现路径 |
|------------------------------|--------|
| `lucky-crunching-bee.md` | `master-design.md` |
| `memory-handoff.md` | `handoff.md` |
| `memory-phase1-data-foundation.md` | `phase-1-data-foundation.md` |
| `memory-phase2-global-l5-port.md` | `phase-2-global-l5-port.md` |
| `memory-phase3-pi-8k-coordinator.md` | `phase-3-pi-8k-coordinator.md` |
| `memory-phase4-kscc-soft-reset.md` | `phase-4-kscc-soft-reset.md` |
| `memory-phase5-polish.md` | `phase-5-polish.md` |
| `phase2-*-mimo-*.md` | `archive/2026-07-31-phase2-*.md` |

**未迁入**：`*-agent-*.md`、会话花名 md（`lucky-crunching-bee.md` 设计正文已迁；同名会话流水与 agent 转储仍只在 `.context/`）。
