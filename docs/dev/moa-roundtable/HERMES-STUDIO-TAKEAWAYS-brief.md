# 探索 brief · Hermes Studio 通盘取经（MoA / 圆桌主线对照）

> **角色**：只读探索 + 落盘取经清单，**不改** TAgent 与 hermes-studio 任何业务代码  
> **模型**：`kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> **探索根目录**：`C:\Users\loumi\Desktop\AI\hermes-studio`  
> **对照宪章（必读节选）**：  
> - `C:\Users\loumi\Desktop\AI\TAgent-Desktop\docs\plans\multi-runtime\README.md`  
> - `…\03-mechanisms-subagent-kanban-moa.md`  
> - `…\05-moa-and-kscc.md`  
> - `…\06-ux-visibility-and-layout.md`  
> - `…\07-implementation-phases.md`（Phase E MoA 相关）  
> **产出路径**：`C:\Users\loumi\Desktop\AI\TAgent-Desktop\docs\dev\moa-roundtable\HERMES-STUDIO-TAKEAWAYS.md`

---

## 目标

对 Hermes Studio **整个项目**做取经（不只「多模型」），回答：

1. 它做成了哪些 TAgent 还没做 / 做弱的产品能力？  
2. 哪些想法能直接喂给 TAgent 的 **MoA / 圆桌 / @ / 看板 / Chat·Work** 主线？  
3. 哪些看着炫、但和 TAgent ADR（双核、kscc spawn、Chat/Work 硬拦、角色≠SOUL）冲突，**不要抄**？

重点：**可取之处 + 映射到 TAgent 哪份文档/阶段**，不是写 Hermes 使用手册。

---

## 探索范围（必须覆盖，可并行扫目录）

| 域 | hermes 里大概看哪 | 对照 TAgent |
|---|---|---|
| 架构分层 | `ARCHITECTURE.md`、`packages/{client,server,desktop}` | Electron 主/渲染、pi-core vs kscc |
| Agent 对话 / 流式 | chat-run、Socket.IO、bridge、session DB | Chat 流、session-runtime |
| **群聊 / 圆桌 / 多席位** | group-chat、room、multi-agent、debate 等（全文搜） | MoA、@ 顺序发言、圆桌卡 |
| **多模型 / 会诊 / aggregator** | MoA、ensemble、jury、vote、reference、aggregator | `moa-orchestrator`、05 文档 |
| Profile / 角色 / 人格 | profiles、persona、soul、role | 04 角色库、ADR-0006 |
| 看板 / 任务 / 派工 | Kanban、tasks、crew、workflow 可视化 | Phase D 看板、Work 模式 |
| 工作流可视化 | workflow 编辑器、可执行图 | 有无借鉴；勿盲目上重编排器 |
| 渠道 / 自动化 | Telegram…Cron、MCP | 自动化模块（正交则单列「旁路可取」） |
| 记忆 / 压缩 / token | memory、compaction、context usage | 已有双核记忆；只记差异点 |
| UX 布局 | 右栏、mosaic、会话窗、工具轨迹 | 06 UX |
| 桌面分发 | Electron、updater、bundled runtime | 发版/打包旁路 |
| 文档与 harness | `docs/`、`AGENTS.md`、`DEVELOPMENT.md` | 协作规范可取否 |

用 ripgrep / Glob 在 hermes-studio 内搜关键词示例：  
`group` `room` `moa` `ensemble` `roundtable` `debate` `kanban` `workflow` `profile` `seat` `aggregator` `mention` `@` `multi-model` `jury`

中文 README 若乱码，以 `README.md` + `ARCHITECTURE.md` + 源码为准。

---

## 产出格式（强制）

写 `HERMES-STUDIO-TAKEAWAYS.md`，结构如下：

### 0. 一句话定位
Hermes Studio 是什么（相对 TAgent / Hermes Agent）。

### 1. 项目地图（半页内）
包结构 + 请求流 + 状态落盘位置（`~/.hermes*` 等）。

### 2. 可取清单（核心，按优先级）

每条用统一模板：

```markdown
#### T-xx 标题
- **Hermes 做法**：（路径 + 关键符号，1–3 句）
- **对 TAgent 的价值**：（用户可见结果）
- **映射**：（`multi-runtime/0x-…` 或 Phase E/F / 旁路模块）
- **移植成本**：低 / 中 / 高
- **风险 / 不要照抄**：（若有）
```

至少覆盖：**圆桌/群聊 UX、MoA 或等价多答聚合、角色/Profile、看板或 workflow 与会话关系、会话/流式基础设施、桌面壳**。  
「多模型」单独成条可以，但**不得**占满清单——至少一半条目标题不叫多模型。

分三档：
- **P0 主线该吃**（MoA/圆桌/机制边界）
- **P1 值得记**（体验/工程）
- **P2 旁路/以后再说**

### 3. 明确「不取」清单
至少 3 条：与 ADR/双核/kscc 网关约束冲突或过度工程的点。

### 4. 建议下一刀（给总监）
3–5 条可开实现 brief 的候选（每条一句话 + 建议依赖），**本轮不要实现**。

### 5. 证据索引
关键文件路径列表（便于验收抽查）。

---

## 禁止

- 改 hermes-studio 或 TAgent 的 `apps/` `packages/` 代码  
- git commit / push  
- 大段粘贴 LICENSE 以外的源码进 TAKEAWAYS（路径+符号+摘要即可）  
- 把「安装试用 Hermes」当成交付；交付是文档结论  
- 假装有 MoA：搜不到就写「无经典 MoA，等价能力是 X」

---

## 验收

- [ ] `HERMES-STUDIO-TAKEAWAYS.md` 存在且含 §0–§5  
- [ ] P0 至少 3 条，且含非「多模型」条目  
- [ ] 「不取」至少 3 条  
- [ ] 每条 P0 有 hermes 路径证据  
- [ ] `git diff --stat` 对 apps/packages 为空  

返回总监：先列 P0 标题列表，再给 TAKEAWAYS 路径。
