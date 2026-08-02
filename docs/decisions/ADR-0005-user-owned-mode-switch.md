# ADR-0005：Chat/Work 模式切换的用户主权

> **状态**：已拍板（2026-08-02）  
> **模块**：multi-runtime  
> **详设**：[docs/plans/multi-runtime/02-chat-work-and-permissions.md](../plans/multi-runtime/02-chat-work-and-permissions.md)  
> **相关**：ADR-0003

---

## 决策

1. **`executionMode` 的变更权威仅属于用户。**  
2. Agent **可以建议**切换，并触发 UI 确认条。  
3. **仅当用户确认**（或用户直接拨动开关）后，系统才修改 `executionMode`。  
4. Agent **不得**通过工具/内部 API 静默切换。  
5. **任意对话轮次**均可切换；不限制频率（可对「完全自动」首次进 Work 加软确认）。  
6. **Work → Chat** 不默认取消已 running 的看板 worker；UI 提示后台仍在执行。  
7. 实现层：改模式请求必须带 `source: 'user' | 'user-confirm-suggestion'`；拒绝 `agent-tool` 等。

---

## 背景

- Chat/Work 改变工具能力与安全边界，等同敏感权限。  
- 若模型可自切，会出现：未同意就写文件、或为绕开限制来回切模式。  
- 用户明确要求：「切 chat 和 work 都只能是用户来做；agent 建议，用户确认后才能切。」

---

## 否决方案

| 方案 | 否决原因 |
| --- | --- |
| Agent 工具 `set_execution_mode` 无确认 | 用户失控 |
| 根据关键词自动切 Work | 误触发写操作 |
| 禁止中途切换 | 真实流程需要「对齐↔执行」多次往返 |
| 回 Chat 自动 kill workers | 用户只想讨论不等于停工 |

---

## 后果

- 产品文案与确认条为 P0 交互。  
- 审计可选：`executionModeHistory`。  
- 测试必须覆盖「建议未确认则模式不变」。

---

## 修订

| 日期 | 说明 |
| --- | --- |
| 2026-08-02 | 采纳 |
