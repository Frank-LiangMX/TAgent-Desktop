# FIX — 消息队列：中断布局空洞 + 立即发送 / 引导两态

## 现象

1. **布局 bug**：运行中把消息送进队列 → 中断后，运行胶囊与下箭头仍停在很高位置，中间已无队列卡片（`--session-stack-over-cluster` / `--session-composer-top` 滞后；停止时 `setMessageQueue([])` 丢消息且 AnimatePresence 退出未强制重测）。
2. **产品缺口**：队列面板只有移除/清空。草稿态虽有「引导 / 立即发送」，**已入队消息**无法操作。用户期望两态：
   - **立即发送**：打断当前轮，以队列消息作为新一轮（`stopAgent` → `sendQueued`）
   - **引导**：不打断；本轮结束后 agent 自动读到（`steerAgent` → live / `pending_next_turn`）

## 契约

### A. 布局

- `messageQueue.length === 0` 时立刻把 `--session-stack-over-cluster` 置 `0`，并 `scheduleComposerTopUpdate()`（含 motion exit 完成回调）。
- 用户停止**不再静默丢弃**队列（见 B）；若仍清空则必须同步重测。

### B. 停止 vs 队列消费

- **用户点停止**：只中断，**保留** `messageQueue`；**禁止**走「`running→false` 自动逐条 `sendQueued`」一次（用 `skipQueueAutoConsumeRef` 或等价：userStop 置位，effect 跳过并清位）。
- **自然 turn_end**（非用户停）：保持现有自动消费队列行为。

### C. MessageQueue UI

在标题栏（或首条操作区）增加：

| 动作 | 行为 |
|------|------|
| **立即发送** | 取当前队列快照 → 清空 UI 队列 → `stopAgent`（若仍 running）→ 按序 `sendQueued`；重测布局 |
| **引导** | 对每条（或仅全部文本合并策略：逐条）调 `steerAgent`；成功后从 UI 队列移除；ticker 提示 live / pending_next_turn；**不** stop |
| 清空 / 单条 × | 现有；清空后强制重测 |

禁用态：队列空时不显示动作；引导/立即发送进行中防双击。

### D. 本轮不做

- 不重做 Pi 长驻 runLoop
- 不改权限/AskUser 横幅
- 不改默认「运行中点发送入队」路径（仍入 UI 队列；用户再用面板两态）

## 主要文件

- `apps/electron/src/renderer/components/chat/MessageQueue.tsx`
- `apps/electron/src/renderer/components/chat/Chat.tsx`（停止、auto-consume、handlers、remeasure）
- 必要时 `chat.css` 微调队列操作按钮

## 验收

1. 运行中入队 → 点停止：队列仍在；胶囊/箭头贴回队列顶（无空洞）；再点「立即发送」→ 中断收尾后新轮发出。
2. 运行中入队 → 「引导」→ 当前轮不打断；结束后/边界处 agent 收到引导（ticker 有反馈）；UI 队列清空。
3. 自然结束（不点停止）仍自动消费队列。
4. 清空/移除后 `--session-stack-over-cluster` 回到 0，箭头不悬空。
