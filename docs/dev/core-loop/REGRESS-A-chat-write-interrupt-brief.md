# REGRESS-A Brief — Chat 下 Write 仍走「用户拒工具」打断会话

> 规格：`docs/dev/core-loop/REGRESS-2026-08-07-SPEC.md` §A  
> 派工：本机 `kscc -p --dangerously-skip-permissions`（禁止 Cursor Task）

## 现象

用户在 **Chat** 模式会话里，模型执行 `Write`，会话中断，出现：

```
The user doesn't want to proceed with this tool use. The tool use was rejected
(eg. if it was a file edit, the new_string was NOT written to the file).
STOP what you are doing and wait for the user to tell you how to proceed.
```

这是 **Claude Agent SDK / kscc 用户拒工具** 控制文（见 `isSdkControlUserMessage`），**不是** 产品期望的中文 `CHAT_MODE_BLOCK_*` / `chat_mode_blocked` Banner。

## 必须回答（带行号证据）

1. Write 在 Chat 下实际走了哪条路径？
   - `evaluatePermission` → `isChatModeBlockedTool` → deny + `chatModeBlockHandler`？
   - 还是漏读 `executionMode`（当成 work）→ `askRenderer` → 用户拒/超时 deny？
   - 还是 `canUseTool` 根本没挂上 / 子代理裸奔？
2. deny 后 SDK 为何吐英文「doesn't want to proceed」而不是 `CHAT_MODE_BLOCK_REASON`？`createCanUseTool` 的 `behavior:'deny'` 是否带上 `message`？
3. `chatModeBlockHandler` 注册点在哪？interrupt 是否把「正常 Chat 硬拦」渲染成「用户拒工具」？
4. 渲染层：该英文控制文是否被当成普通错误打断 UX？`SessionErrorBanner` / `chat_mode_blocked` 是否没触发？

## 修复目标（定位后最小改）

按优先级：

1. **根因**：保证 Chat + Write **一定**走硬拦，绝不进 ask-user 拒工具路径。
2. **UX**：硬拦后用户只看到中文切 Work 引导；英文 SDK 控制文不进可见气泡（已有哨兵则确认生效；Banner 必出）。
3. 加/补 vitest：`executionMode=chat` + Write → deny + hard-stop；断言 reason / 不走 askRenderer。

## 主要文件

- `apps/electron/src/main/lib/permission/permission-service.ts`
- `packages/shared/src/constants/permission-rules.ts`
- `apps/electron/src/main/lib/ipc/session-service.ts`（`getExecutionMode` / `createCanUseTool` / `chatModeBlockHandler` 注册）
- `packages/shared/src/utils/session-error-classify.ts`
- `apps/electron/src/renderer/components/chat/SessionErrorBanner.tsx`
- `apps/electron/src/renderer/components/chat/session-turn-model.ts`（控制文哨兵）

## 不做

- 不改默认 Work、不删硬拦、不自动切 Work
- 不 commit / push
- 不改 concise 时间线（那是 Agent B）

## 交付

1. 写 `docs/dev/core-loop/REGRESS-A-FINDINGS.md`（根因 1–3 条 + 证据路径:行）
2. 最小代码修复 + 单测
3. stdout：改动文件列表 + 测试命令与结果
