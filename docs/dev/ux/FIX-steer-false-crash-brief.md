# FIX — 引导报「会话进程异常退出，自动恢复失败」

## 现象

队列「引导」后出现 `运行出错` / `[session …] 会话进程异常退出，自动恢复失败`。

## 根因

Pi 核每轮 `result` 后 generator 仍会再收尾退出。`onTurnEnd` 里立刻 `flushPendingSteer` → `handleSend`：

1. 此时 `loopRunning` 仍为 true → `hasLiveProcess()` 为真 → 走 **enqueue**（`turnInFlight=true` 再置回）
2. 旧 `runLoop` for-await 退出时看到 `turnInFlight===true` → 误判崩溃 → Pi 无 resume →「自动恢复失败」

## 修法

1. `SessionRuntime`：本轮已干净 `result` 后退出 **永不**走崩溃恢复；增加 `onLoopIdle`（loop 真正停稳后回调）；`isLoopRunning()` 供 STEER 判断。
2. `session-service`：Pi 的 `flushPendingSteer` 从 `onTurnEnd` 挪到 `onLoopIdle`；kscc 仍可在 `onTurnEnd` flush（长驻不退 loop）。STEER 空闲立刻 flush 条件改为 `!isTurnInFlight() && !isLoopRunning()`。
3. 单测：模拟 result → onTurnEnd 里再 send → 旧 loop 退出不报错。

## 验收

- 运行中入队 → 引导 → 本轮不打断；结束后自动发引导，**无** session_error /「自动恢复失败」
- 停后点引导：能发出，无假崩溃
- 既有崩溃恢复 / 过长上下文单测仍过
