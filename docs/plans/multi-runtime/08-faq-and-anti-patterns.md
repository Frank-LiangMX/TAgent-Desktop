# 08 — FAQ 与反模式（回溯速查）

> 所属：[multi-runtime](./README.md)  
> 用途：吵架/复盘时 30 秒定位「当时怎么定的」  

---

## 1. FAQ

### Q1：主会话要不要角色？

**不要默认岗位角色。** 只要 SOUL。  
@ / follow / 显式外套才叠角色。见 ADR-0006、[04](./04-role-library.md)。

### Q2：是不是所有会话都要角色？

**否。** 需要的是「被派活/被点名/会诊席」的那次运行，不是每个会话实体。

### Q3：MoA 是并行还是互聊？

**默认并行独立 + 汇总。** 互聊是多轮可选。见 [05](./05-moa-and-kscc.md)。

### Q4：@ 多角色算不算 MoA？

**不算。** @ 是群聊；MoA 是会诊交卷。见 D5、[03](./03-mechanisms-subagent-kanban-moa.md)。

### Q5：为什么 Frakio 分 Chat/Work？

讨论（mention）与看板派工预期不同；Chat 不碰看板。我们同构分层。见 ADR-0003。

### Q6：Plan/自动/完全自动和 Chat 并列吗？

**不并列。** 它们是 Work 下（或写操作上）的 permission。见 [02](./02-chat-work-and-permissions.md)。

### Q7：谁能切 Chat/Work？

**仅用户**（含点 Agent 建议确认）。Agent 不能擅切。见 ADR-0005。

### Q8：能不能任意轮切换？

**能。** Work→Chat 默认不杀 running worker。

### Q9：kscc 怎么开多模型会诊？

kscc 自带多模型，模板内选不同 modelId 即可，不必多外部 Key。见 D14、[05](./05-moa-and-kscc.md)。

### Q10：过程要不要给用户看？

**要。** 主会话简报，点进看详情。类 Cursor/Codex。见 D12、[06](./06-ux-visibility-and-layout.md)。

### Q11：看板还要单独一页吗？

**非必须主入口。** 右栏伴生为主；全局任务中心弱入口。见 D13。

### Q12：react-mosaic 上不上？

**默认不上整壳。** 可选 main 内工作台。见 D15、[06](./06-ux-visibility-and-layout.md)。

### Q13：1.0 为什么缓做 MoA？Desktop 为什么又做？

1.0：成本高、与看板/SubAgent 重叠。  
2.0：收窄为会诊层 + kscc 池 + 统一 ChildRun，不替代看板。

### Q14：Chat 里 Agent「建议建板」怎么办？

可建议；真正建板/派工须 **Work** 且用户确认切模式（若在 Chat）。不可 Chat 静默派工。

### Q15：改模块行为先改哪？

先改 `docs/plans/multi-runtime/*` 或 ADR，再改代码；PR 链接章节。见 [README](./README.md) §5。

---

## 2. 反模式清单（发现即违规）

| ID | 反模式 | 正确做法 |
| --- | --- | --- |
| AP1 | Chat 里 Write 成功 | 工具层拒绝 |
| AP2 | Agent 工具直接 setExecutionMode | 只出确认条 |
| AP3 | @ 自动创建 kanban task | 仅消息路由 |
| AP4 | 主会话强制选 coder 才能聊 | 默认 SOUL |
| AP5 | 三席 MoA 全文刷主时间线 | 卡 + 点进详情 |
| AP6 | Worker 内 create_board | 禁止递归编排 |
| AP7 | 用聊天记录当看板真值 | kanban DB |
| AP8 | 250 角色默认全 @ | pin 子集 |
| AP9 | Plan 与 Chat 同一下拉五选一 | 双轴 UI |
| AP10 | Work→Chat 杀掉所有 worker | 默认保留 + 提示 |
| AP11 | MoA 参考席默认全工具改仓库 | 参考无工具 |
| AP12 | 只靠 system 一段话区分 Chat/Work | 分叉注入 + 硬拦 |
| AP13 | 角色库存 API Key | Key 在渠道 |
| AP14 | 独立看板页当唯一入口 | 右栏 + 对话 |
| AP15 | mosaic 替换 AppShell | 壳不动，main 可选 |

---

## 3. 场景速判卡（可打印）

```
要改文件/跑有副作用命令？
  否 → Chat（或保持）
  是 → 必须 Work（用户确认切换）

只要聊清楚 / 插话？
  → Chat + @

同题多模型交叉意见、少插话？
  → MoA

多步交付、离开、依赖？
  → Work + 看板

小事一锤子？
  → SubAgent 或主会话自办
```

---

## 4. 修订

| 日期 | 说明 |
| --- | --- |
| 2026-08-02 | 初版 |
