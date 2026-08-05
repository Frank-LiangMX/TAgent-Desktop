# CL3 Brief — 权限超时可预期（禁静默失败）

> 规格：`docs/dev/core-loop/00-SPEC.md` CL3

## 目标

权限请求超时（当前约 120s auto-deny）后，用户必须**看得见失败原因**，禁止「横幅消失、工具其实没跑」的静默态。

## 要求

1. 横幅上显示剩余时间或明确「即将超时」提示（倒计时即可）
2. 超时 deny 时：清横幅 + 用户可见错误条/提示（复用 `SessionErrorBanner` 或回合级错误条），文案说明「权限确认超时，已拒绝」
3. 不改 allow/deny/`updatedInput` 协议本身；不改默认 120s 时长也可，但必须可见
4. 尽量补浅测或状态断言

## 主要文件（按需）

- `PermissionBanner.tsx` / `permission-atoms.ts` / `permission-service.ts`
- `Chat.tsx` / `SessionErrorBanner.tsx`（错误抬升）

## 不做

- 不重写权限队列、不改 Chat 硬拦语义（CL4）
- 不 commit / 不 push

## 交付

文件列表 + 如何手动验证超时路径 + typecheck/测试结果。
