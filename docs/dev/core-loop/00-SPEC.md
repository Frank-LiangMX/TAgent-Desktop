# 核心会话主链冲刺规格（收消息 → 流式 → 终态 → 权限 → Chat/Work）

> 日期：2026-08-05  
> 角色：总监规格。子代理据此实现，不得自行扩大范围。  
> 基线：HEAD 含 `25b557d`（权限/终态/默认 Work）+ `be62b76`（Checkpoint 2 消闪空）。  
> 目标：**发版节奏由这条主链决定**——丝滑、可预期、不静默失败。

---

## 1. 产品一句话

用户发消息后必须稳定经历：

```
发送被接住 → 思考/工具/正文逐 token 出现 → 终态答案一次收口
→ 需要权限时弹窗可操作 → Chat 讨论 / Work 干活语义清晰
```

任一环「卡死 / 闪空 / 双份 / 静默失败 / 不知道为什么不能写」= 发版阻断。

---

## 2. 主链现状（对照审计）

| 段 | 状态 | 说明 |
|----|------|------|
| 消息接收 | 绿 | 发送 / STOP→turn_end 路径完整 |
| 流式输出 | 黄 | W5 消闪已合；**W1 `streamState` 未落地**，仍绑 DisplayItem |
| 最终答案 | 黄偏绿 | 条件拆分 + 同批清流式已合；断流/idle 看门狗缺 |
| 权限 | 绿偏黄 | `updatedInput` + 队列 + RESOLVED 已合；**120s 静默 deny**；需实机回归 |
| Chat/Work | 绿(新)/黄(旧) | 新会话默认 work+bypass；旧 chat 会话写拦易懵 |

审计文档 `usability-audit/00-MASTER.md` 里部分「未修」已过时，以本文件 + HEAD 为准。

---

## 3. 本冲刺只做（Core Loop Sprint）

按用户感知排序。每项单独 commit。

| 编号 | 工作流 | 验收 | 建议渠道 |
|------|--------|------|----------|
| **CL0** | **实机回归清单**（不改码） | 新会话 Work：发消息流式可见；Bash/Write 不 ZodError；Allow/Deny 横幅；STOP 后 idle；Chat 切回后写被拦且有引导 | MiniMax 视觉 + 人测 / grok 写清单 |
| **CL1** | **W1 流式状态分离** | delta 只进会话级 `streamState`，不改 `items`；KSCC 无占位 thinking 不丢；uuid 乱跳不重挂；完整消息同批进 items 再清 streamState | **kscc** |
| **CL2** | **idle / 断流看门狗** | 无流式事件 N 秒且主进程 idle → UI 清 running；STOP 后 pill/停止键必收敛 | kscc 或 grok |
| **CL3** | **权限超时可预期** | 120s 前强提示倒计时；超时 deny 必须可见错误条，禁止「横幅没了工具没跑」静默 | grok / mimo（窄） |
| **CL4** | **旧 Chat 会话写拦 UX** | 不改硬拦语义；首次写拦 → 明确「切 Work」引导（Banner/条），禁止只吐工具失败原文 | grok / mimo |

### 依赖

```
CL0（验证基线）──并行──► CL3, CL4
         └────────────► CL1 → CL2（CL2 可与 CL1 尾并行）
```

---

## 4. 本轮明确不做

- 升 `pi-coding-agent` `AgentSession`
- MoA / @ 多角色群聊 / 看板大改
- 子代理 token 级嵌套流、独立 JSONL
- Streamdown、搬 Proma EventBus
- partial coalescer / `dropTrailingAbortedAssistant`（排下一冲刺）
- 对外 `TAGENT_EXTERNAL` 全量出包（可并行另开，不挡主链丝滑）

---

## 5. CL1 契约摘要（对齐 `streaming-rework/00-SPEC` §3.1）

```
items: DisplayItem[]     // 只放已落盘消息 / taskCard
streamState: { text, thinking }  // 会话级，与 items 分离
```

- delta **只**累加 `streamState`
- 段边界清空：`tool_start`、`turn_end`、新用户输入
- 完整 assistant 到达：先推进 `items`，**同一批**清 `streamState`
- live 回答正文 / 思考取 `streamState`，不依赖 uuid 绑定
- 拆分规则仍遵守 Checkpoint 2：`canSplit` 条件外置，禁止提前闪进回答区

主要文件：`Chat.tsx`、`stream-item-model.ts`（或继任）、`session-turn-model.ts`、`AssistantTurnView.tsx` + 单测。

---

## 6. CL0 回归清单（必须先跑）

环境：Windows，**重启 Electron main** 加载 HEAD。

1. 新会话（确认 Work + bypass）发短问 → 正文逐 token，结束后无双份、无闪空  
2. 触发 thinking 的模型 → 思考过程区可见，不进回答区；结束后可自动折  
3. Work 下 Write 小文件 → 成功，无 ZodError  
4. 切权限档到需确认 → 横幅出现，Allow 后继续，Deny 后可见失败  
5. 运行中点停止 → ≤2s 内 idle，计时/停止键恢复  
6. 切 Chat → 再 Write → 被拦且有「切 Work」类引导  
7. 切回 Work → Write 成功  

任一项红 → 开缺陷 brief，**先修再进 CL1**。

---

## 7. 工程门禁

- `bun run typecheck` 全绿  
- 相关 vitest 全绿（含 turn-presentation / stream 新测）  
- 不擅自 push；checkpoint 由总监或用户要求再 commit  

---

## 7.1 已落地：Cursor 式简洁时间线（2026-08-06）

`displayMode=concise` 改为 timeline 段投影（思考折叠 / 工具簇 / 穿插正文），不再是「过程行变矮 + 底部回答壳」。  
决策与规则：[CURSOR-CONCISE.md](./CURSOR-CONCISE.md)。

---

## 8. 派工备忘

| 渠道 | 本冲刺用法 |
|------|------------|
| kscc | CL1（核心）、必要时 CL2 |
| grok | CL2/CL3/CL4 实现草稿、对照探查 |
| MiniMax | CL0 视觉走查 |
| mimo flash | CL3/CL4 极窄补丁（省着用） |
