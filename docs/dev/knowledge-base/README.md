# 知识库开发文档

知识库当前的产品方向是：外部资料由 Agent 读取、整理成结构化知识，经用户确认后入库，再按知识片段检索和引用。它不是 Office/WPS 阅读器，也不是原始文件管理器。

## 当前生效文档

按以下顺序阅读：

1. [KB-DESIGN-DECISION.md](./KB-DESIGN-DECISION.md) — 当前最高优先级的产品决策、边界和统一工作流。
2. [KB-PRODUCT-SPEC-v2.md](./KB-PRODUCT-SPEC-v2.md) — 详细产品规范、数据对象、Agent 契约和验收标准。
3. [KB-PROJECT-BRAIN-ROADMAP.md](./KB-PROJECT-BRAIN-ROADMAP.md) — 当前开发顺序和阶段闸门。
4. [KB-PHASE0-FINDINGS.md](./KB-PHASE0-FINDINGS.md) — 已完成底座、现存缺口和实现记录。
5. [KB-AGENT-MODE-DESIGN.md](./KB-AGENT-MODE-DESIGN.md) — 会话模式、资料整理、检索和受控写入规则。
6. [KB-CLOUD-SOURCE-DESIGN.md](./KB-CLOUD-SOURCE-DESIGN.md) — 本地、云文档和 Office 文件作为来源材料的获取与解析边界。

## 历史文档

KB-PRODUCT-SPEC-v1.md、KB-FEASIBILITY-*.md、KB-PHASE0-brief.md 和 KB-P1-*.md 保留为评审、派工和实现过程记录。它们可能包含早期的原样文档、Office 高保真或阶段性拆分方案，不作为当前产品方向依据。

## 当前开发主线

~~~text
聊天附件 / 本地文件 / 云文档链接
        → Agent 读取和解析
        → 结构化知识草稿
        → 用户确认
        → 正式知识
        → 片段切分和索引
        → Agent 快速检索与引用
~~~

当前继续围绕这条主线推进：完成真实附件到结构化草稿的端到端验收，再补持久化片段索引；云文档页面还原和 Office 导出属于后续辅助能力。
