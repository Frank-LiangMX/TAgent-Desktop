# KB 可行性圆桌 · Round 2 汇总（交叉辩论后）

> 来源：`KB-FEASIBILITY-R2-brief.md`  
> 复评：`R2-kscc.md` / `R2-grok.md` / `R2-mimo.md`  
> 日期：2026-08-23

---

## 辩论后收敛（三人基本一致）

| 议题 | R1 分歧 | R2 终态 |
|------|---------|---------|
| **D1 MVP 厚度** | 厚 / 中 / 极瘦 | **统一到极瘦 P1**：库 + 直存(MD/文本) + FTS + `@kb` + 会话绑定 + 来源徽章。**candidate 门控进 P1**（仅用户触发）。素材池/半自动归类 → **P2** |
| **D2 是否自建** | 自建 / 自建+MCP / 质疑自建 | **统一：Phase 0 文件夹+检索验证 → 需要策展再自建 `kb-store`**。MCP 作逃生舱，不是终局（mimo 已改口） |
| **D3 Agent 策展** | P2 / P2 差异化 / P1 不做 | **P1 零 Agent 自主写**。P2 可上，但必须 **diff + candidate + Revision 回滚**。mimo 更严：P2 也要看真实频次再开 |
| **D4 BotMemory** | 并存可收编 / 严格隔离 / 文案区分 | **统一严格隔离**：Bot 只读 KB；KB 不得 activate 成 BotMemory。kscc **撤回收编**。文案「参考书 vs Bot 经验」叠加 |

**仍硬延后（无人翻案）**：多视图导出、Office 高保真、无人值守改规范、默认 Qdrant/RAGFlow。

---

## 仍存的细分歧（不阻塞立项，影响 P2 闸门）

| 点 | kscc | grok | mimo |
|----|------|------|------|
| Phase 0 是否必做 | 推荐必做（去风险） | 可选，但建议做 | 推荐必做 |
| P2 策展是否「默认开」 | 默认开（3 周包） | 默认开（验证后） | **数据驱动**：6 周内 ≥3 次合并请求才开 |
| BotMemory 收编窗口 | 最早 P3+，FusionRoom 稳后 | **永不默认收编** | 8 周观察，无需求就不收 |
| 置顶规范进 Frozen | 独立段，非 Frozen | 可选短摘要进 system（绑定变更重建 session） | **禁止**进 Frozen，一律 messages 头部 |

---

## 终裁路径（总监按 R2 多数写死）

```
Phase 0（≤1 周，强烈建议）
  knowledge/ 目录 或 用户指定 MD 文件夹
  + 只读检索 AgentTool/@kb + 来源标注
  → 若「只搜规范就够」→ 停，不建子系统
  → 若需要策展/确认成稿/深度绑定 → 进 Phase 1

Phase 1（3–4 周）
  自建 kb.db + blobs
  库 CRUD + 模板集合
  MD/纯文本直存（Office/截图 = 原件 + best-effort 文本）
  FTS5 + @kb dual-mount + 会话绑定
  candidate→active（仅用户显式「整理入库/确认」）
  KB Rail 面板 + [KB: xxx] 徽章
  与 L0–L5 / BotMemory 写入隔离
  ✗ 素材池 ✗ Agent 主动策展 ✗ 多视图 ✗ 向量

Phase 2（+2–3 周，P1 用过再开）
  素材池 + Agent 提议合并（强制 diff/confirm + Revision）
  简单增量版本链
  （可选）Office 加强 / MCP 外挂重解析

明确不做（首年）
  无人值守改规范 / Word·脑图·表格主路径 / 默认向量服务 / BotMemory 收编
```

---

## 各方让步一览

- **kscc**：P1 向 mimo 砍瘦；D4 向 grok 改口严格隔离；接受 Phase 0；P2 吸收 grok 的 diff+Revision。
- **grok**：素材池从 P1–P2 捆包挪出首发；接受 Phase 0；P1 零 Agent 自主写。
- **mimo**：改口同意自建（不再纯 MCP 终局）；接受 P1 必有 candidate 门控；仍最严卡 P2 策展触发条件。

---

## 用户已拍板（2026-08-24）

1. **场景**：先做 A（能搜能引用）；B 预留。原件+派生；PixelRAG 非 MVP  
2. **作用域**：库与项目文件夹不强关联；会话可绑多库；解释权归用户  
3. **写入**：永远人工 confirm（candidate→active）  

→ 契约见 [`KB-PRODUCT-SPEC-v1.md`](./KB-PRODUCT-SPEC-v1.md)

---

## 文档索引

| 文件 | 内容 |
|------|------|
| [KB-FEASIBILITY-R2-brief.md](./KB-FEASIBILITY-R2-brief.md) | R2 辩论 brief |
| [KB-FEASIBILITY-R2-kscc.md](./KB-FEASIBILITY-R2-kscc.md) | kscc 复评 |
| [KB-FEASIBILITY-R2-grok.md](./KB-FEASIBILITY-R2-grok.md) | grok 复评 |
| [KB-FEASIBILITY-R2-mimo.md](./KB-FEASIBILITY-R2-mimo.md) | mimo 复评 |
| [KB-FEASIBILITY-SYNTHESIS.md](./KB-FEASIBILITY-SYNTHESIS.md) | R1 汇总 |
