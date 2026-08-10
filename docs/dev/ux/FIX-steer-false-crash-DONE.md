# FIX-steer-false-crash DONE

## 根因

Pi：`onTurnEnd`（仍在 for-await）里 `flushPendingSteer` → `handleSend` 在 `loopRunning` 仍真时 enqueue，把 `turnInFlight` 再置真；旧 loop 退出误判崩溃 →「自动恢复失败」。

## 改动

- `session-runtime.ts`：`sawCleanResult` 退出不走崩溃恢复；`onLoopIdle`；`loopEpoch` 防旧圈改写新 loop
- `session-service.ts`：Pi flush 改到 `onLoopIdle`；kscc 仍在 `onTurnEnd`；STEER 立刻 flush 需 `!isTurnInFlight() && !isRunning()`
- 单测：竞态不报错 + `onLoopIdle` 触发

## 验收

运行中「引导」→ 本轮不打断 → 结束后自动发 → 无假 session_error。
