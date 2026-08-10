# FIX-message-queue-steer DONE

## 改动

- `MessageQueue.tsx`：标题栏加「引导」「立即发送」；exit 完成强制 `tagent:composer-top-remeasure`
- `Chat.tsx`：
  - 用户停止**保留**队列；`skipQueueAutoConsumeRef` 跳过一次 auto-consume
  - 队列 length→0 / 清空 / 立即发送时立刻 `--session-stack-over-cluster: 0` + 重测
  - `sendQueueNow`：stop（若 running）→ 按序 `sendQueued`
  - `steerQueue`：逐条 `steerAgent`，成功后裁剪 UI 队列 + ticker

## 验收

1. 运行中入队 → 停止：队列仍在；胶囊/箭头无悬空空洞
2. 「立即发送」→ 中断后新轮发出
3. 「引导」→ 不打断；ticker 提示；UI 队列清空
4. 自然 turn_end 仍自动消费队列
