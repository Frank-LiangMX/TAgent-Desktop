# ADR-0006：角色库与 SOUL 分离；主会话默认不绑岗位

> **状态**：已拍板（2026-08-02）  
> **模块**：multi-runtime  
> **详设**：[docs/plans/multi-runtime/04-role-library.md](../plans/multi-runtime/04-role-library.md)、[01-glossary-and-truth-model.md](../plans/multi-runtime/01-glossary-and-truth-model.md)  
> **代码锚点**：`packages/shared/src/types/agent-role.ts` 头部注释

---

## 决策

1. **SOUL（默认人格）** = 主会话全局身份与沟通红线；宜稳定。  
2. **Role（角色库）** = 任务/席位级岗位能力契约（prompt、modelPool、权限倾向等）。  
3. **二者永不合并**为同一配置对象。  
4. **主会话默认不强制赋予岗位角色**（不要求用户先选 coder 才能聊）。  
5. 角色用于：看板 worker、`roleId`、MoA 席、SubAgent 投影、Chat `@`（用户 pin 子集）。  
6. Worker 等子运行 prompt = **短 SOUL 核心 + 角色 prompt + 任务上下文**（合成单点函数）。  
7. 角色是契约不是进程；实例是 session/run/task 绑定。

---

## 背景

- 1.0 已区分 SOUL 与角色库（看板 worker）。  
- 商店 250+ 角色若等同主会话人格，会污染 cache、身份与路由。  
- Frakio 式「员工」适合 Chat 点名，不适合取代主会话总助。

---

## 否决方案

| 方案 | 否决原因 |
| --- | --- |
| 每个会话必须选一个角色才能开始 | 摩擦高；总助场景被抹掉 |
| SOUL 拆成 N 个互斥岗位 | 丢失统一调度长 |
| 角色库条目 = 常驻 OS 进程员工 | 真值混乱 |
| 主会话 system 注入全部角色全文 | 爆窗、路由迷失 |

---

## 后果

- `@` / follow 是「外套」，不是永久替换 SOUL。  
- 角色商店安装默认不全部 mentionable。  
- 实现：`composePrompt` 单点；禁止各处手拼。

---

## 修订

| 日期 | 说明 |
| --- | --- |
| 2026-08-02 | 采纳 |
