# 04 — 全局角色库

> 所属：[multi-runtime](./README.md)  
> 关联：ADR-0006  
> 拍板：D1, D2, D3  

---

## 1. 定位

角色库是 **能力契约注册表**，不是 Agent 进程池。

```
Role ──绑定──► @mention | SubAgent | MoA seat | Kanban worker
```

一份定义、多种运行时投影。

---

## 2. SOUL vs Role（D1, D2）

| | SOUL | Role |
| --- | --- | --- |
| 问题 | 主会话「我是谁」 | 「这事交给谁干」 |
| 数量 | 模式/产品级，宜少 | 多，可安装 |
| 主会话默认 | ✅ 使用 | ❌ 不强制岗位 |
| Worker/MoA/SubAgent | 可叠短 SOUL 核心 | ✅ 主体 |
| Cache | 宜稳定进 system | 任务级变化 |

**主会话默认不赋予 coder/reviewer 等岗位。**  
仅在 `@` / follow / 用户显式「本会话默认外套」时叠加角色层。

注释共识（既有代码）：  
`packages/shared/src/types/agent-role.ts` 头部 — worker prompt = SOUL 核心 + 角色 prompt。

---

## 3. 既有类型（Desktop）

权威：`AgentRoleProfile`

已有字段：

- `id`, `displayName`, `description`, `systemPrompt`  
- `permissionMode`, `modelPool`, `maxConcurrentPerModel`  
- `fallbackToChannelDefault`, `channelId?`  

`DEFAULT_ROLES`：8 个内置（含 generalist 兜底）。  
商店：`RoleStoreCatalog` / `role-store-catalog-data.ts`（agency-agents-zh）。  
存储约定：`~/.tagent[-dev]/agent-roles.json`。  
IPC 通道常量：`AGENT_ROLE_IPC_CHANNELS`（实现待齐）。

### 3.1 建议演进（v2，实现期）

在不破坏现网的前提下 **optional 扩展**（详见讨论，实现 PR 再锁 schema）：

- `tags`, `category`  
- `runtimeModes: ('kanban-worker'|'moa-seat'|'subagent'|'mentionable')[]`  
- `tools` / `disallowedTools`  
- `outputContract`  
- `moa?: { stance, preferCostTier, ... }`  
- `version`, `source`, `builtin`  
- `RoleCrew` 班底模板  

商店安装默认 `runtimeModes` 偏 `kanban-worker`，**不**自动全量 mentionable/subagent。

---

## 4. 供应关系

```
商店 Catalog ──install──► 本地 agent-roles.json
用户 .md 导入 ──import──►
内置 DEFAULT ──seed/reset►（builtin 不可删可重置）
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
     mentionable          subagent 投影      worker / moa
     （用户 pin 子集）     （短目录）         （roleId / seats）
```

### 4.1 启用策略

| 用途 | 策略 |
| --- | --- |
| @ 列表 | 用户 pin 团队，默认 5～8，非 250 |
| SubAgent 目录 | 更短；显式启用 + 内置 explorer/reviewer/researcher |
| 看板下拉 | 已安装 + 内置；缺省 generalist |
| MoA 班底 | 模板引用 roleId + model 覆盖 |

---

## 5. 解析与派工

看板 dispatcher 契约（对齐 1.0）：

1. 无 `roleId` → `DEFAULT_KANBAN_ROLE_ID`  
2. `modelId` 显式 > `modelPool` 轮询 > 渠道默认  
3. `role.channelId` 受看板合规（kscc 板不跳外部等）  
4. `maxConcurrentPerModel` 与 board 并发取严  
5. 审核类倾向 `permissionMode: auto` + 非交互 auto_deny  

**单点函数**：`resolveForWorker(task)` / `resolveForMoASeat` / `roleToSubagentDef`。  
**禁止** 各处手拼 system prompt。

### 5.1 Prompt 合成顺序

1. SOUL 核心（短）  
2. 角色 systemPrompt  
3. 运行时约束（Chat/Work、approval、输出契约）  
4. 任务 body / 议题 / @ 用户句  
5. blackboard 或 peers 摘要  

MoA 参考席注意 **compact**：长角色 prompt 可截断/compact 版，防 4 席爆窗。

---

## 6. 统计

既有 `RoleWorkStats`（看板工时）。后续可扩展 mention/moa 使用次数，非 P0。

---

## 7. 非目标

- 主会话永久变成某商店角色且不可回总助  
- 商店全量默认启用  
- 角色库存 API Key  

---

## 8. 修订

| 日期 | 说明 |
| --- | --- |
| 2026-08-02 | 初版 |
