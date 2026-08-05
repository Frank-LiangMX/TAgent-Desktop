# CL2 Brief — idle / 断流看门狗

> 规格：`docs/dev/core-loop/00-SPEC.md` CL2  
> **依赖 CL1**：若 CL1 正在改 `Chat.tsx`，本任务等 CL1 合入或只改 `useGlobalSessionRunSync` 等独立文件。

## 目标

停止或断流后，UI 的 running / 计时 pill / 停止键必须收敛到 idle，禁止长期卡死。

## 要求

1. 渲染层：无流式事件超过 N 秒（建议 15–30s，可常量）且主进程 `getSessionStatus`/`session` meta 为 idle → 调用现有 `stopSessionRun` / 清 streaming 路径
2. STOP 后：已有 `turn_end` 路径保持；看门狗是兜底不是替代
3. 有单测或可测的纯函数（超时判定），避免只能手测
4. 参考：`docs/dev/usability-audit/03-renderer-ux-state.md` idle reconcile

## 主要文件（按需）

- `useGlobalSessionRunSync.ts` 或等价
- `Chat.tsx`（仅兜底接线，最小改动）
- session run atoms

## 不做

- 不重写 Pi interrupt 核、不升 AgentSession
- 不 commit/push

## 交付

文件列表 + N 秒取值说明 + 测试结果。
