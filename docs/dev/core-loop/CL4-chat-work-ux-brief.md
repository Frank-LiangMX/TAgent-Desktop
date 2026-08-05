# CL4 Brief — 旧 Chat 会话写拦 UX 引导

> 规格：`docs/dev/core-loop/00-SPEC.md` CL4

## 目标

**不改** Chat 下硬拦写操作的语义。当用户在 `executionMode=chat` 下触发写/派工等被拦工具时，UI 必须明确引导「切换到 Work」，禁止只显示生硬工具失败原文。

## 要求

1. Chat 模式硬拦发生时：可见 Banner 或回合错误条，文案含「当前为讨论模式（Chat），写入/改文件请切换到 Work」
2. 若已有切换入口，在提示里点明；不要自动静默切 Work
3. 新会话默认 work 保持不变
4. 浅测：给定 chat 模式 block 事件 → 出现引导文案

## 主要文件（按需）

- `permission-service.ts`（`isChatModeBlockedTool` 返回/事件是否可带 reason）
- `Chat.tsx` / `PermissionBanner` / `SessionErrorBanner` / execution mode 切换 UI

## 不做

- 不改默认权限档、不删硬拦、不 commit/push

## 交付

文件列表 + 手动验证步骤 + 测试结果。
