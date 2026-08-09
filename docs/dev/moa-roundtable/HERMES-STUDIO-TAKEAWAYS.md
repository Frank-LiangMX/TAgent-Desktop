# Hermes Studio 通盘取经 — 对照 TAgent multi-runtime 宪章

> **取经对象**：`C:\Users\loumi\Desktop\AI\hermes-studio`（整仓只读探索，未改任何业务代码）
> **对照宪章**：`docs/plans/multi-runtime/{README,03,05,06,07}.md` + ADR-0001/0003/0004/0005/0006
> **定位**：只读结论文档。不是 Hermes 使用手册；重点是「可取之处 + 映射到 TAgent 哪份文档/阶段」。
> **日期**：2026-08-08

---

## 0. 一句话定位

Hermes Studio 是一个 **Vue3 + Koa + Electron 的「自托管 AI 仪表盘」**——它是 **Hermes Agent（外部 Python Agent）的 UI/服务/桌面壳**，自己不是 Agent；相对 TAgent-Desktop，它对应的是「Electron 壳 + 会话/流式基础设施 + 看板 UI」这一层，而把"Agent 大脑"外包给上游 Hermes Agent 二进制（含 MoA 循环、kanban dispatcher）。它的 multi-runtime 等价物是 **ekko-agent（进程内 TS 第二核）↔ Hermes Python bridge（子进程第一核）**，正好对照 TAgent 的 pi-core ↔ kscc 双核。

---

## 1. 项目地图（半页）

| 包 | 职责 | 对照 TAgent |
| --- | --- | --- |
| `packages/client` | Vue3 + Pinia + Naive UI；`stores/hermes/{chat,group-chat,kanban,models,profiles}` | 渲染层 / Chat 气泡 / 右栏 |
| `packages/server` | Koa + Socket.IO + SQLite；`services/hermes/{run-chat,group-chat,hermes-kanban,agent-bridge,workflow-manager,write-gate}` | 主进程 / session-runtime / 看板 / MoA 装配 |
| `packages/desktop` | Electron 壳 + 捆绑 Python/Hermes runtime + **双更新通道** | Electron + AppShell + 打包旁路 |
| `packages/ekko-agent` | **进程内 TS 第二 Agent 核**：runtime/tools/memory/skills/delegation | pi-core vs kscc 的"第二核"参考 |
| `packages/{esp32-c3,skills,website}` | MCU 固件 / Markdown 技能 / 营销站 | 旁路 |

**请求流**：浏览器 → Koa → `/chat-run` Socket.IO → `ChatRunSocket.handleRun` 按 `source`/`coding_agent_id` 分发 `handleBridgeRun`（Hermes Python bridge 子进程）/`handleEkkoAgentRun`（进程内 ekko）/`handleCodingAgentRun`（Claude/Codex CLI）。群聊走**独立** `/group-chat` namespace + 独立 `gc_*` SQLite 表。MoA 不开新会话字段，作为 `provider:'moa'` 虚拟模型挂在 model picker。

**状态落盘**：Web UI 状态 `~/.hermes-web-ui`（`HERMES_WEB_UI_HOME`）；Hermes Agent 状态 `~/.hermes`（per-profile `config.yaml`/`auth.json`/`skills`/`pending`）；ekko 状态 `~/.ekko/ekko.db`（单库、`profile_id` 行级隔离）；群聊 `gc_rooms/gc_room_agents/gc_messages/gc_room_members/gc_room_summaries` 在 Web UI SQLite。

---

## 2. 可取清单（按优先级）

> 统一模板：Hermes 做法 / 对 TAgent 的价值 / 映射 / 移植成本 / 风险·不要照抄

### P0 主线该吃（MoA / 圆桌 / 机制边界）

#### T-01 群聊房间的「持久化席位 + 共享工作区 + @ 防递归」机制 → 喂给 TAgent 的 @ 圆桌
- **Hermes 做法**：`packages/server/src/services/hermes/group-chat/{index.ts,mention-routing.ts,agent-clients.ts,room-summary.ts,group-message-ordering.ts}` + `db/hermes/schemas.ts`。@ 是**唯一**发言路由：`resolveMentionTargets`/`resolveStructuredMentionTargets` 做边界感知（CJK/ASCII）`@name` 匹配并**屏蔽 `<quoted_message>` 块内 @**；`@all` 仅房主可用。**agent→agent 转发有深度上限**：`maxAgentMentionDepth()` 默认 4（env `HERMES_GROUP_CHAT_MAX_AGENT_MENTION_DEPTH`，上限 10），`index.ts:2525` `isAgentReply && mentionDepth < maxAgentMentionDepth()` 闸住，注释明写「bounds chained agent-to-agent handoffs so one prompt cannot loop forever」。每个 agent 席位带独立 `provider/model/apiMode/reasoningEffort`（`gc_room_agents`）；房有**共享工作区** + 每 run 的 `workspace_diff` 挂回父 assistant 消息；`GroupRoomSummaryService` 每 N 轮跑一次隔离 ekko 步维护**跨席位共享 room memory**，所有 agent 经 `GroupRuntimeContext` 读到。`groupRunOrder` 把 `<base>_part_<n>_(toolcall|toolresult)` 解析后按 run 分组排序，并发流不串。
- **对 TAgent 的价值**：TAgent 的 @ 目前是「chip `@A→@B` + system 注入角色投影顺序发言，非真多进程」（07 Phase B2 ⚠️）。Hermes 证明可把 @ 做成**真多席位**且不失控。**可直接搬的机制件**（不必搬整个"房间"子系统）：① agent→agent 提及深度上限（防一个 prompt 无限 handoff）——TAgent 的 @ 现在没有这个闸；② 跨席位共享 summary 作为多席位上下文；③ 结构化 mention + 引用块屏蔽（避免被引用文本误触发路由）；④ 并发流按 run 分组排序的排序键。
- **映射**：`03 §6 @讨论`、`06 §4 @呈现`、Phase B2 升级。
- **移植成本**：中（机制件可移植，无需搬 invite-code/guest-agent relay）。
- **风险 / 不要照抄**：Hermes 群聊是**独立子系统**（独立 store/namespace/表），而 TAgent 宪章 D5 明定 @ 留在**同一主会话时间线**、不建 kanban task。只搬机制件，**不要**把 @ 做成另一个重房间子系统；也不要抄"多人类房间 + 跨源 relay"（见 §3-N4）。

#### T-02 MoA 作为「虚拟模型 / 预置班底」挂在 model picker（不是独立重 runtime）
- **Hermes 做法**：`packages/server/src/controllers/hermes/{config.ts,models.ts}` + `services/hermes/{model-context.ts,run-chat/{session-command,handle-bridge-run,bridge-message}.ts}` + `agent-bridge/python/bridge_pool.py`。经典 MoA 真实存在：预置 = `reference_models[]`（并行席位）+ `aggregator`（汇总）+ `reference_temperature/aggregator_temperature/max_tokens`（`config.ts:245 defaultMoaPreset` / `:256 normalizeMoaPreset`）。`models.ts:540 buildAvailableForProfile` 把启用预置作为 `provider:'moa'` 模型条目（group 名 `Mixture of Agents`，`api_mode:'chat_completions'`）——**选预置 = 设会话模型，不加新会话字段**。`model-context.ts resolveMoaAggregator` 把上下文窗口解析到**汇总模型**的窗口；`ChatInput.vue isMoaSession` 隐藏 reasoning-effort 滑块；`moa.reference` 渲染成 display tool/reasoning，`moa.aggregating`+最终文作为 assistant 消息。注意：真正的扇出/汇总 prompt 在**外部** `agent.moa_loop.MoAClient`（bridge import），Studio 只负责配置/装配/事件转发/渲染。
- **对 TAgent 的价值**：这正是 TAgent Phase E「MoA 产品化」（E1 班底+参与池 / E2 圆桌卡 / E3 ChildRun 统一 / E4 结论 CTA）的**先行验证**——「MoA 是可选模型/预置，不是并列第五个重 runtime」。可搬：① 预置作为 model picker 条目；② 上下文窗口按汇总模型解析；③ MoA 会话隐藏 per-session reasoning 控制；④ 参考席产出作为"点进看全文"的 drill-in（ChildRun `moa-seat`），汇总作主结论卡。也与 README §4.2「Hermes → MoA 定义」+ `2026-07-03-hermes-borrow-plan`（评审缓做）→ Desktop「重开但收窄」（05 §6）的演进线吻合。
- **映射**：`05 §1-2`、`05 §4 MoARoundtableConfig`、`05 §5 UI`、Phase E E1-E4、`06 §3 圆桌卡`。
- **移植成本**：中（`packages/pi-core/src/moa-orchestrator.ts` 已有 `runReferenceModels`+`buildAggregatorPrompt`，缺的是「预置即模型 + UI + 上下文解析」产品化层）。
- **风险 / 不要照抄**：Hermes 的 MoA 循环**外包给外部 Python runtime**——TAgent 不得外抛，MoA 必须留在 pi-core/kscc（ADR-0001 双核 + D14 kscc 池）。Hermes 席位/汇总**无工具**（仅 display tool 行）——正好契合 05 §5.2「参考席无工具；汇总可只读工具」。Hermes 把 MoA 锁在单聊、群聊 add-agent 不含 MoA——与 D4/D5（MoA ≠ @ 群聊）同向，可借鉴。

#### T-03 机制边界对照：Hermes 四套并行编排各占独立存储 vs TAgent ADR-0004 四语法共享运行时内核
- **Hermes 做法**：四套编排**物理隔离**——群聊（`gc_*` 表 + `/group-chat` namespace）、MoA（外部 `MoAClient` + 虚拟 provider）、workflow（`workflows`/`workflow_run_*` 表 + 进程内 `WorkflowManager` DAG 调度）、kanban（`hermes-kanban.ts` **shell out** 到 `hermes kanban` CLI，脑在二进制）。它们各自有自己的存储/调度/生命周期，**没有**共享的 `AgentRunRequest` 抽象；唯一共享层是 `/chat-run` 会话运行时 + `sessions/messages/session_usage` 表 + 压缩链。
- **对 TAgent 的价值**：**反向验证** TAgent ADR-0004「SubAgent/看板/MoA/@ 四语法共享运行时内核、禁混用语义」的合理性。Hermes 的"每套编排各自为政"导致 workflow 节点、群聊 agent、MoA 席位重复实现"装配 user message / 跑 run / 记 usage / 工具审批 / 压缩"——TAgent 用 `03 §8 AgentRunRequest`（`purpose: subagent|kanban-worker|moa-seat|mention-turn`）统一这些，是更省的路线。可借的点是：**Hermes 用 `source`/`coding_agent_id` 标签分发到同一 `handleRun`** 的做法，可作为 TAgent 四语法"只构造 Request、spawn 与计量统一"的参考实现。
- **映射**：ADR-0004、`03 §7 合法组合矩阵`、`03 §8 共享运行时内核`。
- **移植成本**：低（这是"不照抄结构、只取对照结论"）。
- **风险 / 不要照抄**：不要学 Hermes 把每套编排做成独立重子系统；TAgent 的优势恰恰是共享内核 + 边界靠"purpose 标签 + 工具策略 + 生命周期"区分。

#### T-04 Chat(只读)/Work(副作用) 硬边界 vs Hermes 全 per-tool 审批 —— 刻意分叉 + 借「持久化自改进写闸门」
- **Hermes 做法**：**没有 Chat/Work 执行模式分叉**。`run-chat/index.ts handleRun` 只有 `handleBridgeRun`/`handleEkkoAgentRun`/`handleCodingAgentRun` 三条分发，无"只读分支"。副作用全靠**逐工具审批**：危险工具 emit `approval.requested`（once/session/always/deny），`/yolo` 会话级一键放行（`session-command.ts case:'yolo'`）。唯一接近"模式"的是 `docs/hermes-write-gate.md` + `write-gate.ts` 的**写闸门**：仅对 `memory`/`skills` 两类**影响未来 agent 行为的持久化自改进写入**做"暂存待审"（`config.yaml memory.write_approval/skills.write_approval`），普通文件/终端副作用不进此门。
- **对 TAgent 的价值**：① **反向验证** TAgent ADR-0003/D10「Chat 硬只读：Write/kanban 派工在 Chat 必失败」是**刻意分叉**——Hermes 的"全 per-tool 审批"会让"讨论"和"干活"边界模糊，TAgent 不应回退。② **正向可借**：Hermes 的 write-gate 思路（保护**影响未来行为**的写入：角色/技能/MoA 模板改写需确认）是 TAgent 权限体系之外的一个**正交窄闸门**——TAgent 可加一道"角色库/技能/MoA 预置的持久化自改进写需用户确认"，与 Chat/Work 模式无关。
- **映射**：ADR-0003、`02 Chat·Work 与权限`、D10；正向窄闸门 → `04 角色库`/权限服务。
- **移植成本**：低（窄闸门是加法，不撼动 Chat/Work 硬边界）。
- **风险 / 不要照抄**：**不要**用"Hermes 式全 per-tool 审批"替代 TAgent 的 Chat/Work 硬分叉（见 §3-N1）。

### P1 值得记（体验 / 工程）

#### T-05 双核共存模式：进程内 TS 核 + 子进程 Python 核共享 socket/会话/压缩/审批
- **Hermes 做法**：`ekko-agent`（进程内 TS，`GlobalEkkoAgent` per-profile 单例）↔ Hermes `agent-bridge`（Python 子进程 broker+profile worker，IPC/TCP，`AgentBridgeClient` 裸 net socket）。两者**共享** `/chat-run` socket、`sessions/messages/session_usage` 表、压缩链（`2026-07-26-ekko-external-context-compression`）、`approval/clarify` 事件；**差异**在进程模型、工具实现、记忆库（`ekko.db` vs `memories/MEMORY.md`）、审批内部（`EkkoToolApprovalService` vs `tools.approval`）。`handleRun` 按 `source`/`coding_agent_id` 分发。
- **对 TAgent 的价值**：TAgent ADR-0001 双核（pi-core vs kscc）的**先行参考**——"两核、一套共享会话/存储/socket 层、按标签分发、工具/记忆/审批各自实现"。验证 TAgent `03 §8` 统一 `AgentRunRequest` + 统一计量的方向。
- **映射**：ADR-0001、`03 §8`、session-runtime。
- **移植成本**：低（参考性，TAgent 已有双核）。
- **风险**：TAgent 的 kscc 是 spawn 网关（CLI 子进程），不是 ekko 那种"进程内 TS"——进程模型类比松，**可借的是"共享层 + 标签分发"原则**，不是进程形态。

#### T-06 子运行可见性：并发流按 run 分组 + workspace_diff 挂父消息（ChildRun 渲染范式）
- **Hermes 做法**：`group-message-ordering.ts groupRunOrder`/`sortGroupMessagesCanonical` 把多段 run（reasoning→toolcall→toolresult→final）解析成连续块排序；`stores/hermes/group-chat.ts mapGroupMessages` 把 assistant+tool_call 拆成 tool 行、合并 tool 结果、把 `workspace_diff` 挂回父 assistant；`groupAgentRunMessages` 把一个 run 收成一张 `role:'agent_run'` 卡（`runItems`），`GroupAgentRunCard.vue` 渲染。
- **对 TAgent 的价值**：TAgent D12「两层披露」+ `06 §2 ChildRun`（subagent/moa-seat/kanban-worker 共用）的具体渲染范式——"多段 run 收成一张卡、diff 挂父消息、点进去看工具行"。
- **映射**：`06 §1-2`、D12、Phase E E2/E3。
- **移植成本**：中（渲染范式，不需搬群聊消息存储）。
- **风险**：不要连群聊消息存储一起搬；这是给 TAgent 现有 ChildRun 用的排序/分组/diff 挂载模式。

#### T-07 压缩快照 cursor + revision CAS + 跨核统一 usage 记账
- **Hermes 做法**：`compression-snapshot` 带 message cursor + protected-head cursor + `history_revision`（CAS：陈旧 in-flight summary 失败、clear/delete 事务性失效、branch 重映射 cursor ID）；`2026-07-11-unified-session-usage` 一个规范化 `session_usage` 记账器跨 Hermes Bridge/Coding Agent/Ekko/Group Chat（provider 上报优先、互斥 token 桶、Ekko 每次模型响应 emit `model.usage`→`model_call` 行、Bridge 在 `post_api_request` hook 注册 observer）；大工具结果全量存库但模型历史用 5,500 字符 head/tail 投影。
- **对 TAgent 的价值**：TAgent 已有双核记忆/压缩，**只记差异点**：① revision-CAS 压缩快照防陈旧 summary 覆盖；② 跨核统一 usage 账本（双核必需）；③ 工具结果 head/tail 投影控上下文、全量留库。
- **映射**：session-runtime、ADR-0001 双核计量、记忆/压缩模块（正交，仅差异）。
- **移植成本**：中。
- **风险**：属记忆/压缩模块边界（07 R7），勿让它在 MoA/圆桌主线里喧宾夺主。

#### T-08 记忆 recall 预算 + always-recalled kinds 分类 + CJK token 守卫
- **Hermes 做法**：`ekko-agent/src/memory/{service,retrieval,context}.ts` + `config.ts`。recall 用 **4000 token 预算**（`DEFAULT_AUTOMATIC_MEMORY_TOKEN_BUDGET`，非卡片数）；**always-recalled kinds**（`interaction_contract/language_preference/accessibility_need/communication_preference/hard_constraint` + corrections）恒召回，**contextually-triggered kinds** 按查询正则（双语）触发，文本相关项加权 LIKE + CJK bigram；`selectMemoryNodesByTokenBudget` 兜底；`supersedeNode` 基于 revision 的乐观并发。`memory/tokens.ts countTextTokens` 用 js-tiktoken `cl100k_base`，**连续字母/CJK run >2000 字符**短路到廉价启发式（`cjk*1.5+other/4`）防 O(n²) BPE 卡死。`memory_embeddings` 表已建但**当前不用于检索**（诚实"向量未上"）。
- **对 TAgent 的价值**：TAgent 已有双核记忆，差异点：① token 预算召回（非卡片数）；② always-recalled kind 分类法；③ revision-based 记忆节点冲突解决；④ CJK token 计数守卫；⑤ 诚实预留向量位但不假装已用。
- **映射**：记忆/压缩模块（正交，仅差异）。
- **移植成本**：低（思路）。
- **风险**：同 T-07，正交模块，勿冲主线。

#### T-09 桌面双更新通道 + 不补丁上游 runtime（打包旁路）
- **Hermes 做法**：`packages/desktop/src/main/{webui-server,updater,runtime-manager,runtime-relocation}.ts` + `scripts/runtime-config.mjs`。Electron spawn 捆绑 Koa（端口 8748，捆绑 node/python/git，token file，Windows `taskkill /T /F` 杀树）。**两套独立更新通道**：app 壳走 `electron-updater`（Cloudflare+GitHub feed），Hermes runtime 走 `runtime-manager` tarball（download→sha256 校验→extract→**原子激活**，`runtime-manifest.json`+`active-version.json`）。捆绑 runtime = `python/`(Hermes Git checkout+venv)+`node/`+`git/`+manifest；**Studio 集成留在 Studio，不打补丁上游 Hermes 源**，故用户可直接跑上游 `hermes update`。Windows `pyvenv.cfg` 搬移后重定位修复。pin 三元组（version/ref/commit）**原子覆盖**校验。
- **对 TAgent 的价值**：TAgent 有 Electron+AppShell+捆绑 pi-core。可借：① app 更新与 runtime 更新**分两渠**；② runtime **原子激活**（pending dir→rename）；③ **不打补丁上游、保持干净 checkout 让上游自更新仍可用**的原则；④ Windows venv 重定位修复。
- **映射**：打包/发版旁路、ADR-0002 长驻进程。
- **移植成本**：中。
- **风险**：TAgent 的 pi-core 是**仓内**而非外部 Git checkout，"不打补丁上游"映射点不同；可借的是"分渠 + 原子激活 + 干净分离"原则。

### P2 旁路 / 以后再说

#### T-10 可视化工作流编辑器（Vue Flow DAG + 条件/环路/审批/证据）—— 勿盲上重编排器
- **Hermes 做法**：`views/hermes/WorkflowView.vue` + `services/workflow-manager.ts`（completion-driven DAG + 递归 laminar-loop 调度）；边带 `route:success|failure|always` + 结构化 JSON 条件 + 有界反馈环；节点 = 一个 chat 会话（`source:'workflow'`），节点后 `approvalRequired` 闸门；`route-history`/`portability`/`lifecycle-recovery`（重启 fail-close 孤儿 run）；工作流节点工具审批自动 `once`、禁背景委派。
- **映射/价值**：TAgent 宪章明令"勿盲目上重编排器"+ D13 看板右栏主路径。可视化 DAG 是**重编排器**，与 TAgent"SubAgent+看板+MoA 轻量机制 + 右栏"冲突。**只**在远期"工作台模式"（`06 §6.3 档B`）可借**零件**（结构化 JSON 条件、有界环、节点后审批闸门、route-history 证据），且需严守 ADR-0004 边界。
- **移植成本**：高。
- **风险**：自由 DAG 易模糊 SubAgent/看板/MoA 边界；**勿作默认 Work 路径**（见 §3-N5）。

#### T-11 MCP 四工具集 + OpenAPI 引导 API 调用 + 自动注入
- **Hermes 做法**：`bin/hermes-studio-mcp.mjs`（stdio，4 工具集 `api/browser/devices/use`，profile 级短令牌）；`services/ekko-agent/mcp.ts` 把它作为 `MANAGED_SERVERS` 自动注入 ekko run；`2026-06-15-outbound-relay-mcp-openapi` 用 OpenAPI 引导的 Hermes API 调用**代替**把 bearer 嵌进 prompt。
- **映射/价值**：旁路自动化模块。可借：OpenAPI 引导 API 调用（短令牌 + schema，不把密钥塞 prompt）、managed MCP 按 runtime 自动注入。
- **移植成本**：中。

#### T-12 远程控制 + 消息渠道凭证托管 + Cron 委托 CLI
- **Hermes 做法**：`docs/app-relay.md` + `app-relay/client.ts`（移动 App→本机经云端 relay，Ed25519 机器身份、配对码、转发 HTTP/Socket RPC、事件白名单、20MiB 上限）；`stores/hermes/settings.ts` 存 telegram/discord/slack/whatsapp/weixin 凭证 + `gateway-runner.ts` 托管生命周期（**bot 进程归上游 Hermes**，Studio 只配置+自启）；`controllers/hermes/jobs.ts` per-profile `cron/jobs.json` **shell out** `hermes cron` 执行，结果可投递消息渠道。
- **映射/价值**：旁路。可借思路："存凭证+管生命周期但不跑 bot 进程"、"cron 作业委托 CLI 执行"。
- **移植成本**：中-高。
- **风险**：多人类 invite/relay 对单用户桌面过度工程（见 §3-N4）。

#### T-13 Skills(Markdown) + agent 自演化 + 周期性 review
- **Hermes 做法**：`packages/skills/*/SKILL.md`（YAML frontmatter + Markdown 指令体）；`ekko-agent/src/tools/skills.ts` `skill_list/view/manage`；`skills/review.ts` 每 10 次非管理工具调用跑一次**保守 skill-review**（只能建、只改 Ekko 出处的 skill、永不删）。
- **映射/价值**：旁路。可借：SKILL.md 格式、保守自演化 + 出处 gating。
- **移植成本**：低-中。

#### T-14 实时语音 + MCU/ESP32（纯旁路硬件）
- **Hermes 做法**：`packages/esp32-c3/{v1,v2}` 固件 + `services/global-agent/server.ts`（`/global-agent` 语音 relay，IMA ADPCM 解码、STT/TTS、中断去抖、OLED 字幕）；`docs/voice-dialogue.md` 半双工 STT/TTS + `hermes-studio` 命令 provider 回环代理。
- **映射/价值**：纯旁路硬件/语音，与 MoA/圆桌主线无关，仅备查。
- **移植成本**：高（且不在 TAgent 范围）。

---

## 3. 明确「不取」清单

#### N1 不取「单一模式 + 全 per-tool 审批」替代 Chat/Work 硬分叉
Hermes 无执行模式分叉（`run-chat/index.ts handleRun` 无只读分支），副作用全靠逐工具审批 + `/yolo` + 仅 memory/skills 的写闸门。TAgent ADR-0003/D10 刻意让 Chat 硬只读、Write/kanban 派工在 Chat 必失败。**不要**回退到"全 per-tool 审批"——那会让"讨论 vs 干活"边界靠用户每次点确认维持，与 TAgent 双轴（D6/D7）冲突。证据：`run-chat/index.ts`、`docs/hermes-write-gate.md`、`session-command.ts case:'yolo'`。

#### N2 不取把「角色/身份/配置/凭证」一锅端进单个 profile
Hermes 的 `profile` = `config.yaml`+`auth.json`(凭证)+`skills`+`memory`+pending 写闸门，**无 Role≠SOUL 分裂**；群聊"角色" = 带名参与者（`agent-clients.ts AgentConfig` 含 `profile/provider/model/name`），非可复用岗位契约。TAgent ADR-0006 刻意把 Role（可复用岗位契约，SubAgent/看板/MoA 共享）与 SOUL（全局身份）分开，主会话默认不绑岗（D2）。**不要**抄"profile=一切"的合并模型——它会污染角色库、让席位/委派绑定语义含糊。证据：`hermes-profile.ts getProfileDir`、`controllers/hermes/profiles.ts`、`agent-clients.ts AgentConfig`。

#### N3 不取「编排大脑 shell out 到外部 CLI 二进制、Web 只做 CRUD/事件壳」
Hermes 看板 dispatcher 在 `hermes kanban` CLI 二进制里（`hermes-kanban.ts dispatch()` 跑 `hermes kanban --board ... dispatch`，worker 记 `worker_pid`），Web 服务只是 CRUD/事件壳。TAgent 的 dispatcher 必须在**自己的 runtime**（pi-core）内（ADR-0001/0002 + D14 kscc spawn 网关）——外抛 CLI 当脑会让 worker/席位生命周期对 TAgent 过程可见性（D12）不可观测、与双核+仓内编排模型相悖。**不要**抄 CLI-shell-out 架构。证据：`hermes-kanban.ts dispatch()`、`KanbanCapabilities.source:'hermes-cli'`。

#### N4 不取「多人类房间 + guest-agent 跨源 relay」
Hermes 群聊支持多人类房间：invite-code、guest-agent 配对（`group-chat-agent-link.ts requestPairing/decidePairing/revokeConnector` + `agent-relay.ts` 出站 relay 协议 + 远程 workspace HTTP API + 房主审批）。TAgent 是**单用户桌面**，@ 是"一用户 + 多角色投影在同一时间线"（D5 + `03 §6.2 简化：不必多 OS profile 进程`）。**不要**引入多人类房间 + 跨源 relay 机械——过度工程且与"角色投影 + 模型即可"冲突。证据：`group-chat-agent-link.ts`、`agent-relay.ts`、`agent-relay-store.ts`。

#### N5 不取「自由可视化 DAG 作默认 Work 路径」
Hermes `WorkflowView.vue` + `workflow-manager.ts` 是自由平铺 DAG（条件/环路/审批），作为独立 Work 大页。TAgent D13 明定看板主路径=右栏、独立大页非必须，且宪章"勿盲上重编排器"。自由 DAG 还会模糊 ADR-0004 四机制边界。**不要**作默认；零件（条件/证据）仅远期"工作台模式"可考虑。证据：`WorkflowView.vue`、`workflow-manager.ts`。

---

## 4. 建议下一刀（给总监；本轮不实现）

1. **@ 防递归 + 结构化 mention**：给 `@A→@B` 加 agent→agent 深度上限（默认 4）与引用块屏蔽，把 B2「非真多进程 @」升级为带防递归的席位发言。依赖：B1 pin 角色、`03 §6` @ 边界。（→ T-01）
2. **MoA 预置即模型**：把 `moa-orchestrator.ts` 暴露为 model picker 的 `provider:moa` 预置条目，参考席 drill-in、汇总作主结论卡，MoA 会话隐藏 reasoning 控制。依赖：kscc 参与池 D14、ChildRun 组件、Phase E E1-E3。（→ T-02）
3. **看板 capability-gated UI + goal-judge 复核**：给右栏看板加"特性 supported/partial/missing"降级提示与 goal 闸门复核体验收尾。依赖：已有 dispatcher/worker、Phase D goal 轻量闸门 ✅。（→ T-03 / T-04 旁证）
4. **持久化自改进写闸门**：新增正交窄闸门——角色库/技能/MoA 预置的持久化自改进写需用户确认（仿 Hermes write-gate，但只管"影响未来行为"的写入，不碰 Chat/Work 硬边界）。依赖：角色库 C1/C4、权限服务。（→ T-04 正向）
5. **跨核统一 usage 记账 + 压缩快照 revision-CAS**：双核计量统一账本 + 陈旧 summary 防覆盖。依赖：ADR-0001 双核、记忆/压缩模块。（→ T-05 / T-07）

---

## 5. 证据索引（便于验收抽查）

**群聊 / @ 圆桌 / 多席位**
- `packages/server/src/services/hermes/group-chat/index.ts` — `GroupChatServer`、`handleMessage`、`maxAgentMentionDepth()`(默认4/上限10)、`mentionDepth < maxAgentMentionDepth()` 闸、`fenceCurrentRoomAgentSessions`
- `packages/server/src/services/hermes/group-chat/mention-routing.ts` — `resolveMentionTargets`、`resolveStructuredMentionTargets`、`ALL_AGENTS_MENTION`、`stripMentionRoutingTokens`、引用块屏蔽
- `packages/server/src/services/hermes/group-chat/agent-clients.ts` — `AgentConfig`、`processMentions`、`replyToMention`、`nextMentionDepth`、`backgroundDelegationEnabled:false`
- `packages/server/src/services/hermes/group-chat/room-summary.ts` — `GroupRoomSummaryService`、`GroupRuntimeContext`、`GROUP_SUMMARY_SYSTEM_PROMPT`
- `packages/server/src/services/hermes/group-chat/group-message-ordering.ts` — `groupRunOrder`、`sortGroupMessagesCanonical`
- `packages/server/src/db/hermes/schemas.ts` — `GC_ROOMS_SCHEMA`、`GC_ROOM_AGENTS_SCHEMA`、`GC_MESSAGES_SCHEMA`、`GC_ROOM_MEMBERS_SCHEMA`、`GC_ROOM_SUMMARIES_SCHEMA`
- `packages/server/src/controllers/hermes/group-chat-agent-link.ts` — `requestPairing`/`decidePairing`/`revokeConnector`（不取证据 N4）
- `packages/client/src/stores/hermes/group-chat.ts` — `useGroupChatStore`、`mapGroupMessages`、`groupAgentRunMessages`

**MoA / 多模型 / 聚合**
- `packages/server/src/controllers/hermes/config.ts` — `defaultMoaPreset`(:245)、`normalizeMoaPreset`(:256)、`getMoaConfig`/`updateMoaConfig`
- `packages/server/src/controllers/hermes/models.ts` — `enabledMoaPresetNames`(:33)、`buildAvailableForProfile`(:540，`provider:'moa'`/`Mixture of Agents`/`api_mode:'chat_completions'`)
- `packages/server/src/services/hermes/model-context.ts` — `resolveMoaAggregator`、`getModelContextLength`
- `packages/server/src/services/hermes/run-chat/{session-command,handle-bridge-run,bridge-message}.ts` — `/moa` 命令、`moa.reference`/`moa.aggregating` 事件、`recordBridgeMoaDisplayTool`
- `packages/server/src/services/hermes/agent-bridge/python/bridge_pool.py` — `_install_moa_reference_callback`（import 外部 `agent.moa_loop.MoAClient`）
- `packages/client/src/components/hermes/models/CombinationModelsPanel.vue` + `components/hermes/chat/ChatInput.vue`(`isMoaSession`)
- `docs/chat-chain-changes/2026-06-29-moa-bridge-events.md`、`2026-07-15-moa-session-model-selection.md`

**机制边界 / 看板 / workflow**
- `packages/server/src/services/hermes/hermes-kanban.ts` — `dispatch()`(shell `hermes kanban`)、`getCapabilities()`(`source:'hermes-cli'`)、`--goal` goal-judge、`KanbanCapabilities`
- `packages/server/src/services/workflow-manager.ts` — `WorkflowManager`、`executeCompletionDrivenDagRun`/`executeRecursiveCompiledWorkflowRun`、`waitForNodeApproval`
- `packages/client/src/views/hermes/{KanbanView,WorkflowView}.vue`
- `docs/workflow.md`、`docs/chat-chain-changes/2026-07-09-workflow-node-approval.md`、`2026-07-13-workflow-orchestration-hardening.md`

**Profile / 角色 / 写闸门 / 权限（不取证据 N1/N2）**
- `packages/server/src/services/hermes/hermes-profile.ts` — `getProfileDir`/`getActiveProfileName`/`listProfileNamesFromDisk`
- `packages/server/src/controllers/hermes/profiles.ts` — `list/create/switchProfile`（profile=配置+凭证+技能一锅）
- `packages/server/src/services/hermes/write-gate.ts` + `docs/hermes-write-gate.md` — `listPendingWrites/approve/reject`、仅 memory/skills
- `packages/server/src/services/hermes/run-chat/{index.ts,session-command.ts}` — `handleRun` 三分发（无只读分支）、`case:'yolo'`

**会话 / 流式 / 双核 / 记忆 / 桌面 / 旁路**
- `packages/server/src/services/hermes/run-chat/index.ts` — `ChatRunSocket`、`/chat-run`、`handleRun` 分发
- `packages/server/src/services/hermes/agent-bridge/{README.md,manager.ts,client.ts,python/bridge_broker.py}` — Python bridge 子进程核
- `packages/server/src/services/hermes/run-chat/compression.ts` + `db/hermes/compression-snapshot.ts` — cursor+revision CAS
- `packages/ekko-agent/src/{runtime/runtime.ts,memory/{service,retrieval,context,store}.ts,model/tokens.ts,tools/delegation.ts}` — 进程内 TS 第二核 / 4000-token recall / CJK token 守卫 / `delegate_task`
- `packages/server/src/services/ekko-agent/manager.ts` — `GlobalEkkoAgent` per-profile 单例
- `packages/desktop/src/main/{webui-server,updater,runtime-manager,runtime-relocation}.ts` + `scripts/runtime-config.mjs` — 双更新通道/原子激活/不打补丁上游
- `bin/hermes-studio-mcp.mjs` + `docs/app-relay.md` + `packages/server/src/controllers/hermes/jobs.ts` — MCP/app-relay/cron 旁路
- `packages/esp32-c3/{v1,v2}` + `docs/voice-dialogue.md` — MCU/语音纯旁路

---

> **验收对照**：§0–§5 齐全；P0 共 4 条（T-01 @圆桌 / T-02 MoA / T-03 机制边界 / T-04 Chat·Work 硬边界），其中 3 条标题非「多模型」；「不取」5 条（N1–N5）；每条 P0 均含 hermes 路径证据；未改 `apps/` `packages/` 业务代码、未 commit。
