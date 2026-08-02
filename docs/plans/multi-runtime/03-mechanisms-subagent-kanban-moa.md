# 03 — SubAgent / 看板 / MoA / @ 机制边界

> 所属：[multi-runtime](./README.md)  
> 关联：ADR-0004  
> 拍板：D3, D4, D5, D11  

---

## 1. 总览：四种调度语法

| 语法 | 一句话 | 持久化 | 用户在场 | 典型出口 |
| --- | --- | --- | --- | --- |
| **@ 讨论** | 同会话点名角色轮流说 | 消息历史 | 强 | 共识 / 纪要 |
| **SubAgent** | 临时帮手办完回传 | 通常无工单 | 等结果 | tool_result |
| **MoA 会诊** | 同题并行多席 → 汇总 | 可选 trace | 弱 | 结论卡 |
| **看板** | 工单+调度+工人 | SQLite | 可离开 | 文件/摘要/board done |

**共享**：角色库契约（可选绑定）。  
**不共享**：状态机、是否进会话列表、是否可写盘。

---

## 2. 决策矩阵（主会话 / 产品规则）

| 用户意图信号 | 选择 | 前置模式 |
| --- | --- | --- |
| 查一下、改一处、搜代码 | 自办或 SubAgent | Chat 限只读 SubAgent；Work 可写 |
| 多角色一起聊、人要插话 | **@ 讨论** | **仅 Chat** |
| 方案 PK、怕想偏、要交叉意见 | **MoA** | Chat 或 Work |
| 大需求、多步、离开、依赖、IM 进度 | **看板** | **仅 Work** |
| 先对齐再执行 | Chat/@ 或 MoA → **用户切 Work** → 看板/干 | 切换用户确认 |
| 说不清 | 问用户三选一：继续聊 / 会诊 / 切 Work 开干 | — |

---

## 3. SubAgent

### 3.1 定义

- 父会话 tool 触发（kscc `agents` / Pi `task`）  
- 短生命周期；结果合并回父  
- **≠** Collaboration 工人会话；**≠** 看板 task  

### 3.2 边界

| 允许 | 禁止 |
| --- | --- |
| 探索、审查、调研、小步修改（Work） | 递归 `kanban_*` 建板 |
| 深度默认 1（父→子） | 无限套娃 SubAgent |
| Chat 下只读工具集 | Chat 下写盘 |

### 3.3 与角色

- 内置 3 类应收敛为角色投影或内置 seed 角色  
- 主 Agent 委派目录：短列表 + eagerness，注入 **目录摘要** 非全文  

### 3.4 可见性

- 主会话：折叠块（进行中/完成/失败）  
- 点进：完整工具与输出（类 Cursor/Codex）  

---

## 4. 看板（Kanban）

### 4.1 定义

- 编排层大脑：board + tasks + links + dispatcher  
- 执行层：headless worker 会话（General/Hermes 路线）  
- 任务绑 `roleId` → 角色库解析 model/prompt/权限  

### 4.2 边界

| 允许 | 禁止 |
| --- | --- |
| Work 下创建/派工/暂停/重试 | Chat 下创建工人 |
| Worker 浅只读 SubAgent（谨慎） | Worker 再建 board |
| blackboard 跨任务交接 | 用主会话闲聊当唯一状态真值 |
| requireSummary 回流 | 无 complete 闸门时无限自报 done（goal 模式另见 General） |

### 4.3 状态机（既有类型）

`pending → ready → running → done|failed|blocked|…`  
权威源：**kanban DB**，不是聊天记录。

### 4.4 与 1.0

Desktop 对齐 General：防递归 prompt、项目根注入 body、modelPool 轮询、worker approval 防死锁。  
UX：右栏班组为主，见 [06](./06-ux-visibility-and-layout.md)。

---

## 5. MoA 会诊

### 5.1 定义（D4）

```
同题 → N 席并行独立作答（默认互不可见）→ Aggregator 汇总 → 结论
```

- **不是** 默认多轮互相吵架（那是可选 round≥2）  
- **不是** 看板多工人干不同活  
- **不是** @ 群聊  

### 5.2 边界

| 允许 | 禁止 |
| --- | --- |
| Chat/Work 开会诊 | 用 MoA 替代长跑交付 |
| 参考席无工具；汇总可只读工具 | 席位内建看板 |
| 结论后按钮「建看板」 | 未确认自动大规模改写 |
| kscc 池内组班 | 池外幻想模型 |

细节：[05](./05-moa-and-kscc.md)。

---

## 6. @ 讨论（Chat）

### 6.1 定义（D5）

- 同一主会话时间线  
- 用户 `@角色` 点名；可多选顺序发言  
- 用户随时插话 = 人在环里  
- **不**创建 kanban task（除非用户切 Work 后显式建板）  

### 6.2 与 Frakio

- 对齐：Chat mention 不碰看板  
- 简化：不必多 OS profile 进程；角色投影 + 模型即可  
- followMode：可选  

### 6.3 Work 中

- 默认不做多角色乱 @（D11）  
- 需要扯皮：用户切回 Chat  

---

## 7. 合法组合矩阵

| From \ To | @ | SubAgent | MoA | 看板 |
| --- | --- | --- | --- | --- |
| 主会话 Chat | ✅ | 只读 ✅ | ✅ | ❌ |
| 主会话 Work | 默认 ❌ | ✅ | ✅ | ✅ |
| SubAgent | ❌ | 限深 | ❌ | ❌ |
| MoA seat | ❌ | ❌ | ❌（非嵌套编排） | ❌ |
| Worker | ❌ | 浅只读 ⚠️ | ❌ | ❌ |
| MoA 结论 UI | — | — | — | ✅ 用户确认后 |

**升级路径（鼓励）：**

```
@ 讨论对齐 →（可选 MoA 加固）→ 用户切 Work → 看板/执行
SubAgent 反复失败 → 建议升级看板任务
MoA 结论 → 「按此建板」
```

**降级路径：**

```
误建板的小事 → 取消/合并，改 SubAgent
只需聊天 → 切 Chat，勿硬派工
```

---

## 8. 共享运行时内核（实现方向）

```ts
interface AgentRunRequest {
  purpose: 'subagent' | 'kanban-worker' | 'moa-seat' | 'mention-turn'
  roleId?: string
  modelId?: string
  channelId?: string
  systemPrompt: string
  tools: ToolPolicy
  permissionMode: ...
  approval: 'inherit' | 'auto_deny' | 'auto_approve' | 'bypass'
  maxTurns?: number
  cwd?: string
  workspaceId?: string
  sessionPolicy: 'ephemeral' | 'persistent-child' | 'stateless-completion'
  parentSessionId?: string
  taskId?: string
  moaRoundId?: string
}
```

编排器（mention / moa / kanban dispatcher / task tool）只构造 Request；spawn 与计量统一。

---

## 9. 否决与历史

| 想法 | 结论 | 原因 |
| --- | --- | --- |
| 一切皆常驻员工 Agent | 否 | 冲掉看板真值；1.0 Office 已纠 |
| General 不做完整 MoA | Desktop **场景化重开** | 1.0 因成本/重叠缓做；2.0 定位窄为会诊层 |
| @ 即 MoA | 否 | 并行 vs 群聊；用户预期不同 |
| 只有看板没有 SubAgent | 否 | 小事过重 |

---

## 10. 修订

| 日期 | 说明 |
| --- | --- |
| 2026-08-02 | 初版 |
