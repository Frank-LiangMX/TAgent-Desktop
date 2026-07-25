# ADR-0002：会话=进程长驻（只 kscc 核）

> 状态：已定调（2026-07-25）
> 关联文档：
> - `docs/plans/2026-07-25-longlived-event-loop-rewrite-design.md`（TAgent_General，改造设计）
> - `docs/plans/2026-07-25-kscc-print-longlived-experiment.md`（实测：701ms 复用成功）
> - `docs/plans/2026-07-25-sdk-longlived-process-history-mechanism.md`（SDK 长驻机制）

## 决策

kscc 核采用"会话=进程长驻"：开一个会话 spawn 一个 kscc 进程，常驻直到会话退出，每条消息复用同进程，不每轮重放历史。

- **只 kscc 核**：Pi 核自带循环（Agent 对象在主进程内存），无长驻问题。
- **标签页生命周期=进程生命周期**：标签开着→进程留着，关了/被顶→杀进程，关 TAgent→全杀。
- **跑任务的标签锁死**：正在跑任务的会话不许关、不许被顶。想关先停止（软中断）。
- **无 idle 计时器/无并发上限**：由标签页上限（6 个）+ 跑任务锁死自然管控。

## 为什么不继承旧"一圈一结"

TAgent_General 旧骨架（agent-orchestrator 3997 行）是"发一条→spawn→跑一圈→result→杀进程"，长会话每轮重放历史慢（几分钟无响应）。长驻改成"持续循环"，result 后不 close 进程，等下条。

## 实测验证

- kscc print+stream-json 长驻：同进程记 4278 → 空闲 2 分钟 → 第二条 701ms 答出，进程未退。
- 对照组（新进程）答不出 4278，证明上下文在内存。

## TAgent-Desktop 落地

- `adapters/claude/claude-agent-adapter.ts`：result 后不 channel.close()，进程长驻
- `agent/runtime/session-runtime.ts`：首次 spawn+起循环，后续 enqueue 复用，关会话 destroy
- `ipc/session-service.ts`：sendMessage 分流首条/后续

## 已知缺口（后续补）

- 错误恢复（进程崩 fallback spawn+resume）
- prompt_too_long compaction
- 会话持久化（JSONL + resume 读历史）
