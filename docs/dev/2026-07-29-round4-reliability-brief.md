# [dev] Round 4 Brief — 会话可靠性（崩溃恢复 + 长上下文）

> 主线总监 brief。kscc / glm-5.2 执行。
> 范围：kscc 核进程崩溃可恢复；prompt 过长可降级提示/基础 compaction 钩子。不要做插件/UI 大改。

## 背景

ADR-0002 已知缺口：
- 错误恢复（进程崩 → spawn+resume）
- prompt_too_long / compaction

## 目标（MVP）

### 1. 崩溃 / 异常退出恢复（kscc）

在 `session-runtime` / `claude-agent-adapter` / `session-service` 链路中：

- 检测子进程异常退出 / channel 断连（非用户主动 stop）
- 标记会话 `status: 'error'` 或可恢复中间态
- **自动一次** re-spawn + `resumeSessionId`（已有 meta.sdkSessionId）重试当前/下一条
- 避免无限重试：最多 1 次自动恢复；再失败上报 session_error 给 UI
- 用户主动 stop 不触发自动恢复

### 2. 过长上下文

- 识别 SDK / stderr / result 中的 prompt too long / context length 类错误
- 向 renderer 推送可读 `session_error` 或专用事件文案（中文）
- 若已有 compaction API 可安全调用则接一层；否则至少 **明确错误 + 建议开新会话/压缩**，不要静默失败
- 在 shared 或 session-service 抽纯函数识别错误消息（单测）

### 3. 测试

- 纯函数：错误分类（crash vs user_stop vs prompt_too_long）
- 若可 mock runtime：恢复只触发一次

## DoD

- [ ] 非用户 stop 的进程死掉会尝试 resume 一次
- [ ] 过长上下文有明确中文错误（非裸堆栈）
- [ ] typecheck + 单测绿
- [ ] 不破坏正常长驻路径

## 约束

- 不要 git commit/push
- 不碰插件市场 / 设置大改
- 最小可用，注释说明后续可加重试策略
