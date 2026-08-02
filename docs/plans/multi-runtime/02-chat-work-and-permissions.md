# 02 — Chat / Work 与权限双轴

> 所属：[multi-runtime](./README.md)  
> 关联：ADR-0003、ADR-0005  
> 拍板：D6, D7, D8, D9, D10, D11  

---

## 1. 问题

若把 UI 做成一排：

```
[自动] [完全自动] [Plan] [Chat] [Work]
```

用户无法区分：

- 「我在讨论还是在执行？」  
- 「系统能改我文件吗？」  
- 「@ 会不会变成后台工人？」  

Frakio 用 `executionMode: chat | work` 切开；权限另算。TAgent 采纳**同一分层思想**，并结合自有 Plan/自动体系。

---

## 2. 双轴定义

### 2.1 轴一：`executionMode`

```ts
type ExecutionMode = 'chat' | 'work'
```

持久化建议：会话级 `AgentSessionMeta.executionMode`（默认 `chat` 或产品默认，实现时定；**新建会话默认建议 `chat` 更安全**）。

#### Chat

| 维度 | 规则 |
| --- | --- |
| 目标 | 对齐需求、讨论、只读探索 |
| 主会话姿态 | 总助（SOUL）+ 可 `@` 专家 |
| 读 / 搜 / 网 | ✅ |
| 写本地文件 | ❌ **硬禁止**（服务端工具策略拦截，不单靠 prompt） |
| 有副作用 Bash | ❌ |
| 建看板 / 派 Worker | ❌ |
| SubAgent | 仅只读类；禁止写与 kanban |
| MoA | ✅ 可选会诊 |
| @ 多角色 | ✅ 主能力 |
| 权限 UI | 显示「只读协作」；Plan/完全自动等 **灰掉或隐藏** |

#### Work

| 维度 | 规则 |
| --- | --- |
| 目标 | 交付、改仓库、派工、长跑 |
| 主会话姿态 | **调度长**；少群聊串戏 |
| @ 群聊 | 默认 **关**；岗位用 MoA/看板 role/SubAgent |
| 写 / 命令 / 看板 | ✅ 受 `permissionMode` 约束 |
| SubAgent | ✅ 完整（仍受权限与防递归） |
| MoA | ✅ 执行前决策等 |
| 切回 Chat | 用户确认后；后台 worker 默认不停 |

### 2.2 轴二：`permissionMode`（主要在 Work）

名称以实现与现网 UI 为准，语义上包含：

| 档位 | 语义 |
| --- | --- |
| Plan | 先方案/DAG/步骤；批准前不落地写、不大规模派工 |
| 需确认 / 默认 | 敏感操作问人 |
| 自动 | 多数自批 |
| 完全自动 / bypass | 高信任执行 |

**约束：**

- 不与 Chat/Work **并列**为同一枚举的平等成员  
- Chat 内置「只读权限包」，覆盖用户误选的「完全自动」  
- Work + Plan 时：可规划、可读；写与 `kanban` 派工走批准门闩（与 Frakio plan 类似精神）  

```
UI 示意：

协作：  ( ● Chat | ○ Work )
权限：  Chat 时 → 「只读」只读标签
        Work 时 → ( Plan | 确认 | 自动 | 完全自动 )
```

---

## 3. 模式切换（用户主权）

### 3.1 硬规则（D8）

1. **只有用户**能改变 `executionMode`：  
   - 点击模式开关；或  
   - 点击 Agent 建议条上的确认按钮  
2. **Agent 不得**：  
   - 静默 `setExecutionMode`  
   - 在 Chat 假装 Work 调写工具  
   - 为躲权限擅自切回 Chat  
3. Agent **可以**：  
   - 文案建议切换  
   - 触发 UI 确认条（确认仍算用户动作）  
4. 实现上：IPC/服务改模式须带 `source: 'user' | 'user-confirm-suggestion'`；拒绝 `source: 'agent-tool'`。

### 3.2 任意轮切换（D9）

- 不限制轮次  
- 以「发送前当前模式」为该轮工具集权威；切换发生在用户确认时刻  
- 避免单条消息跨模式混算  

### 3.3 切换副作用

| 切换 | 立即生效 | 不默认做 |
| --- | --- | --- |
| Chat → Work | 工具集按 permissionMode 放开；@ 群聊策略收紧 | 自动建板；自动完全自动 |
| Work → Chat | 写/派工工具收回；可再 @ | **杀掉** running worker |
| 任一切换 | 对话历史保留 | 清空记忆/角色库 |

Work→Chat 时 UI 应提示：若有进行中看板任务，「后台任务仍在执行」。

### 3.4 建议条文案模板

```
【建议切换到 Work】
当前需要修改代码/拆任务执行。Chat 下不能改本地文件。
[切换到 Work 并继续]  [留在 Chat]
```

```
【建议回到 Chat】
需要和你对齐需求，避免在执行中途改方向时误写文件。
[切换到 Chat]  [继续 Work]
```

---

## 4. 工具策略（实现检查表）

### 4.1 Chat 拒绝（必须服务端 enforce）

- Write / Edit / 多文件写入类  
- Bash：允许只读探测白名单则另表；默认禁止 `rm`/`mv`/安装/启服务等  
- `kanban_create_*` / 派工 / complete 工人任务等  
- 任何「自动批准全部写」的旁路  

### 4.2 Work 按 permissionMode

| 操作 | Plan（未批准） | 确认 | 自动 | 完全自动 |
| --- | --- | --- | --- | --- |
| 读 | ✅ | ✅ | ✅ | ✅ |
| 写 | ❌ / 仅草稿 | 问 | 多自批 | ✅ |
| 建看板 | 可草稿，派工门闩 | 按策略 | ✅ | ✅ |
| Worker 内 approval | — | auto_deny 或按 worker 策略 | 同左 | bypass 场景 |

Worker 非交互防死锁：对齐 General/Hermes——**禁止** headless 弹阻塞式审批；auto_deny 记 `blockedApprovals`。

---

## 5. 主会话 system 策略摘要

见总设计；实现时应 **按当前 executionMode 注入不同段落**，Chat 与 Work 两套委派说明，避免一套 prompt 两边打架。

---

## 6. 状态字段建议（实现时）

```ts
// AgentSessionMeta 增补（示意）
executionMode: 'chat' | 'work'
// permissionMode 沿用现有字段名
// 可选审计：
executionModeHistory?: Array<{
  at: number
  from: ExecutionMode
  to: ExecutionMode
  source: 'user' | 'user-confirm-suggestion'
}>
```

---

## 7. 否决方案（回溯用）

| 方案 | 否决原因 |
| --- | --- |
| Chat 与 Plan/自动/完全自动同一枚举五选一 | 维度不同，UI/逻辑爆炸 |
| Agent 工具直接切模式 | 用户失控；与「建议权」冲突 |
| Work→Chat 自动 cancel 全部 worker | 用户只是想讨论，不等于停工 |
| Chat 只靠 prompt 禁止写 | 模型越权；必须工具层硬拦 |

---

## 8. 修订

| 日期 | 说明 |
| --- | --- |
| 2026-08-02 | 初版 |
