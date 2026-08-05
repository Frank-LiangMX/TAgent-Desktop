# 交接文档：双核上下文管理 + 全局记忆系统

> 更新：2026-08-01 — 文档已迁入 `docs/memory/`；Phase 1–5 主体已落地；记忆页对齐 General 并支持层内容浏览。  
> 接续：读本文件 + [master-design.md](./master-design.md) + 各 phase 子文档。

---

## 0. 一句话现状

**Phase 1–5 主体已完成并通过 typecheck + 25 项单测。**  
记忆系统：数据层分离、L5 服务移植、双核 Frozen 注入、IPC/UI、Nudge/L4 接线、pi 8k 协调器、kscc 软重置状态机、阈值自学习与历史归一化均已接入。  
记忆页：General 同构 UI + 各层可读内容（限高 + 主题滚动条）+ 图谱点空白清空选中。

仍可加强（非阻塞）：consolidation/reflect **真 LLM** 接线、本会话向量 embedding、learning-graph 可视化、软重置 summarize 走真实 streamFn。

---

## 1. 完成清单

### Phase 1 ✅
- contextWindow/safeContextLimit + model-window + 渲染层常量
- JSONL 双写分离（SDK / 面板）
- AgentSessionMeta 软重置 + 自学习字段

### Phase 2 ✅
- 12 服务移植 `lib/memory/`
- 启动/quit wiring
- 双核 MEMORY_MANAGEMENT_RULES + Frozen 快照
- autoMemoryDirectory 防线
- IPC + preload + Rail 记忆页 + Nudge toast
- onTurnStart / recordSession / markSessionDeleted

### Phase 3 ✅
- `packages/pi-core/src/session-memory-coordinator.ts`
- 四层预算自适应 + lmidChain + L-rag（L4 FTS5）+ 异步自动压缩
- `pi-agent-adapter` transformContext 改调 coordinator
- sessionMode 透传

### Phase 4 ✅
- `apps/electron/src/main/lib/agent/kscc-soft-reset.ts` 真实服务
- 粗估触发 45%/60%/75% × safeContextLimit
- 廉价清理 / 影子压缩 / 原子切换（D9）
- result 后 onTurnResult；prompt_too_long → onBurst
- sim 测试仍保留

### Phase 5 ✅（基础）
- history-normalizer / compaction-prompt / context-limits-store
- Nudge 用归一化历史
- 爆点自学习回写 learnedSafeContextLimit

---

## 2. 关键路径

| 模块 | 路径 |
|---|---|
| 文档索引 | [docs/memory/README.md](./README.md) |
| 主设计 | [master-design.md](./master-design.md) |
| Phase 1–5 | [phase-1…](./phase-1-data-foundation.md) … [phase-5…](./phase-5-polish.md) |
| 记忆服务 | `apps/electron/src/main/lib/memory/` |
| 软重置 | `apps/electron/src/main/lib/agent/kscc-soft-reset.ts` |
| 8k 协调器 | `packages/pi-core/src/session-memory-coordinator.ts` |
| IPC | `apps/electron/src/main/lib/ipc/memory-service.ts` + session-service |
| UI | `apps/electron/src/renderer/components/memory/` |

---

## 3. 验证

```
cd apps/electron && bun run typecheck
npx vitest run packages/pi-core/src/session-memory-coordinator.test.ts \
  apps/electron/src/main/lib/memory/history-normalizer.test.ts \
  apps/electron/src/main/lib/agent/session-store.test.ts \
  apps/electron/src/main/lib/channel/model-window.test.ts \
  apps/electron/src/main/lib/agent/kscc-soft-reset.sim.test.ts
```

---

## 4. 后续增强（可选）

1. consolidation `defaultExecutor` 接 channel-store + streamSSE  
2. soft-reset 影子压缩改真实 LLM（compaction-prompt）  
3. 本会话向量库 + 渠道 embedding API  
4. learning-graph-service + MemoryGraph 真数据  
5. Chat 层 memory_organizing UI（「正在整理记忆」）  
6. pi MemoryLayerUsageBar  

---

## 5. 子代理派工（总监调度）

> 主 Cursor agent = **总监**：写规格 / 拆工作流 / **用本地 CLI 派工** / 交叉验收。不亲自落地大改。  
> 实现必须走本机 `kscc` / `grok` / `mimo`（见 `.cursor/rules/delegate-subagents.mdc`）。  
> **禁止**用 Cursor Task + composer 顶替本地额度干活。

### 渠道额度（按成本调度）

| 优先级 | 渠道 | 约束 | 适合 |
|--------|------|------|------|
| 省着用 | mimo `deepseek/deepseek-v4-flash` | **计费**，用多花多 | 窄 brief、单测、机械改动；禁止无 brief 空转 |
| 主力额度 | **kscc** | 月额约 **3000 元** | 核心契约实现、对照 Proma/General、验收回归 |
| 频次限 | **MiniMax** | **每 5 小时 400 次**；多模态 | 截图/视觉验收、UI 走查、轻量并行探查 |
| 补位 | **grok**（本地有） | 替代原 codex 位 | 探索/对照/草稿实现；不占 kscc 月额 |
| 不用 | codex | 本地无 | — |

### 调度原则

1. 先写 `docs/dev/**` 规格（根因、契约、验收、本轮不做），再派工。
2. 探索/对照优先 grok 或 MiniMax；真正改核/消闪空契约用 kscc。
3. mimo 只吃「范围极清、可单测验收」的小包，避免计费空烧。
4. 缺错误原文不重写运行核（见 `streaming-rework/01-CHECKPOINT2-SPEC` W7）。
5. 每个工作流单独 commit；不擅自 push。
