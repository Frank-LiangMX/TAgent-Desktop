# ksoc ACP 路线探索（kscc 拆 ACP 后，KCwork 的 ACP 究竟靠什么跑）

> **状态**：调研结论（2026-08-17），只读取证，未动工
> **触发**：用户问「kscc 把 ACP 拆了，那 KCwork 是怎么做到还用 ACP 的？我们能用 KCwork 的方式达成吗」
> **结论先行**：**KCwork 的 ACP 不靠 kscc**——它自带 `ksoc.exe`（133MB，opencode 的金山云改造版），用 `opencode acp` 子命令起 ACP server（TCP/SSE）。ksoc 走同一金山云网关、同一批免费模型（glm/kimi/deepseek），凭证同读 `KSCC_AUTH_TOKEN`/`BASE_API`。所以「kscc 拆 ACP = ACP 死路」是**误判**——还有 ksoc 这条路。但学这条路代价大（换后端 kscc→ksoc + stdio→TCP 架构 + 写 ACP 客户端 + 丢 resume 长驻），且 **08-07 文档当的最大甜头「context usage」在 ksoc 上没证实**（grep ksoc.exe `acp_context_usage` **0 命中**）。综合判定：**比 08-07 当初评估的更不值得投入**。
> **承接**：`docs/plans/2026-08-07-kcwork-kscc-acp-research.md` §6（context usage 甜头）、§11（08-17 复核 kscc 去 ACP）；与 `docs/plans/2026-08-17-kscc-account-failover-research.md`（凭证层备选）正交互补。

---

## 0. 一句话脉络（含反转）

用户问「kscc 拆 ACP 了 KCwork 怎么还用 ACP」→ 以为 ACP 死透了 → 查 KCwork 自带 CLI 发现不是 kscc 是 **ksoc**（opencode 换皮，133MB）→ ksoc 有 `opencode acp` 起 ACP server → **反转：ACP 没死，换了个 CLI 跑** → 追 ksoc 能否白嫖免费模型：grep 实证同网关同模型同凭证（能）→ 追最大甜头 context usage：grep ksoc.exe `acp_context_usage` 0 命中 → **甜头存疑** → 落「比当初更不值得」。

**反转点**：08-07 §11 复核得出「kscc 1.2.1 去 ACP → §8 转 ACP 计划作废 → ACP 死路」，本篇发现这只是「**终端 kscc 这条 ACP 路死**」，KCwork 走的是 ksoc（opencode 内核）的 ACP，是**另一条活路**。

---

## 1. ksoc 是什么（实测）

| 项 | 实测 | 证据 |
|---|---|---|
| 位置 | `D:/Program Files/KCwork/resources/bundled-aioncore/win32-x64/managed-resources/cli/ksoc/1.0.6/win32-x64/bin/ksoc.exe` | KCwork `managed-resources/manifest.json`（08-17 复核 §11.2） |
| 大小 / 版本 | 133.8 MB / 1.0.6 | `ls` + `ksoc --version` |
| 本体 | **opencode 的金山云改造版**（非 kscc 换皮） | `ksoc --help` 顶层 `Commands:` 全是 `opencode acp/mcp/agent/models/stats/export/import/github/session` |
| ACP 能力 | `opencode acp` 子命令起 ACP server | `ksoc acp --help`：`start ACP (Agent Client Protocol) server`，选项 `--port`(默认0)/`--hostname`(127.0.0.1)/`--mdns`/`--cors`/`--cwd` |
| 传输 | **TCP/SSE**（非 stdio） | grep ksoc.exe：`createWebSocket`×8、`SSE`×151、`jsonrpc`×34、`session.update`×4、`agent_message_chunk`×3、`stdio`×155（stdio 仅用于自身 CLI I/O，ACP 走网络） |

- **关键**：ksoc 与系统终端 `kscc` 1.2.1 是**两个不同 CLI**。kscc = claude-code 换皮（Anthropic 协议）；ksoc = opencode 换皮（ACP 原生 server）。KCwork 选了 ksoc 跑 ACP，不碰 kscc。
- 08-07 文档 §2.2「KCwork spawn `kscc --experimental-acp`」描述的是**旧版 KCwork**（08-07 实测时）；8月14版 KCwork 改用 ksoc + aioncore，这是 §11.2「KCwork 自包含」的深层原因——自包含的不只是 CLI 二进制，连 ACP 实现都换了内核。

---

## 2. ksoc 能否白嫖同样的免费模型（能）

grep ksoc.exe（133MB）实证：

| 关键字 | 命中 | 含义 |
|---|---|---|
| `KSCC_AUTH_TOKEN` | 20 | 读同一金山云凭证字段（含报错提示 `export KSCC_AUTH_TOKEN=你的sk`） |
| `BASE_API` | 28 | 读同一网关基址（`process.env.KSCC_BASE_URL` 兜底） |
| `companyCode` | 11 | 有 `setupKscLocalMcp({sk,baseUrl,companyCode})` 走金山云本地 MCP |
| `glm-5` | 6 | 内置 glm-5.2 模型识别（`["glm-5.2","glm-5-2","glm-5p2"]`） |
| `kimi` | 11 | 内置 kimi 识别 |
| `deepseek` | 20 | 内置 deepseek（含 opencode 原生 provider 列表 groq/fireworks/deepinfra/cerebras/baseten…） |
| `anthropic` | 444 | opencode 原生 Anthropic provider（兼容 BYOK） |
| `120.92.138.34` | 0 | 不硬编码网关 IP（走 `BASE_API` env） |

- **结论**：ksoc = opencode 内核 + 金山云网关接入 + 免费模型识别 + ACP server，四合一。走的是**同一道门、同一批免费模型**——TAgent 现有 kscc 核白嫖的 glm/kimi/deepseek，ksoc 都能白嫖。
- 模型清单一致是前提：换后端不会丢免费模型池（08-07 §5.1「两核存在因后端不同」在此对 ksoc 不构成障碍——ksoc 接的是同一个金山云后端）。

---

## 3. 能用 KCwork 的方式达成吗（能学，代价大）

**能学的部分**：ksoc 是现成、独立、带 ACP 的免费模型 CLI。TAgent 写个 ACP 客户端连 `ksoc acp --port N` 即可拿到带 ACP 的免费模型后端，不必依赖 KCwork App 运行。

**代价**（逐条对照 TAgent 现状）：

| 维度 | TAgent 现状（kscc 核） | 学 ksoc 路线 | 代价 |
|---|---|---|---|
| 后端 CLI | 系统 `kscc` 1.2.1（claude-code 换皮） | 改用 `ksoc` 1.0.6（opencode 换皮） | 换后端：spawn 目标、凭证读取、模型 id、输出格式全变 |
| 通信协议 | stream-json（Anthropic 原生流，已接 `kscc-ndjson-parser`） | ACP（JSON-RPC over TCP/SSE） | 重写解析层；删 `kscc-ndjson-parser`，写 ACP 事件转 IR（KCwork `AcpAdapter` 有 `agent_message_chunk`/`agent_thought_chunk`/`tool_call` 映射可抄，08-07 §8.2） |
| 传输 | stdio spawn（`spawnKsccBare` / `spawn-kscc`） | TCP/SSE 客户端 | spawn 链大改：stdio pipe → TCP 连接 + ACP 握手（`initialize`/`protocolVersion`）+ SSE 事件流 |
| 进程模型 | resume 长驻（`--resume <sid>`，SDK 自管 cache，701ms 复用） | opencode `--continue/-s <session>`（有 session 机制，能否替代 resume 待验证） | 可能丢 resume 长驻语义；ACP 无状态，需自建或靠 opencode session |
| 客户端依赖 | 现有 spawn + ndjson parser | 引 `@agentclientprotocol/sdk` 做 ACP 客户端 | 新增依赖 |
| ksoc 获取 | 系统 kscc 已装 | 需打包/定位 KCwork 的 ksoc 或独立分发 ksoc | 分发问题：ksoc 在 KCwork 安装目录内，非系统 PATH；TAgent 不能假设用户装了 KCwork |

- **最大摩擦**：传输从 stdio 变 TCP/SSE。TAgent 现有 spawn 链（`kscc-spawn.ts` bare + `spawn-kscc` resume）全是 stdio pipe；ACP 走网络端口,要起 server + 连 client + JSON-RPC 握手 + SSE 事件分流，是架构级改动，不是换 CLI。
- **分发坎**：ksoc 不是公开 npm 包，藏在 KCwork 安装目录。TAgent 要用 ksoc 得(a)要求用户装 KCwork、(b)从 KCwork 目录偷 ksoc、(c)独立打包 ksoc——三条都不干净。

---

## 4. 最大甜头存疑：context usage 在 ksoc 上没证实

08-07 文档 §6 把「context usage 回来」列为 ACP 唯一实打实甜头——基于旧版 `kscc --experimental-acp` 主动推 `acp_context_usage` 事件。本篇追 ksoc 实证：

| 关键字 | grep ksoc.exe | grep app.asar |
|---|---|---|
| `acp_context_usage` | **0** | 3（但上下文是 aioncore 客户端侧的事件名**枚举**：`["thought","thinking","start","request_trace","acp_context_usage","acp_model_info",...]`，非 server 推送证据） |
| `context_usage` | 0 | 3（同上枚举） |
| `onContextUsage` | — | 0 |

- **判定**：ksoc（ACP server 侧）grep 不到 `acp_context_usage` 推送代码；app.asar 那 3 次是 aioncore（客户端）在**接收侧的事件类型枚举**，不能证明 server（ksoc）会推。
- **存疑方向**：context usage 可能由 aioncore 自己从 token 计数估算（而非 server 协议推送）；若是估算，就跟 TAgent 现有 `kscc-ndjson-parser` 从 `result`/`message_delta` 捞 `usage` 是同一档次，**不是协议级精确值**，甜头打折甚至消失。
- **未做的前置验证**：实跑 `ksoc acp --port N` + ACP 客户端连上，观察是否真收到 `acp_context_usage` 事件、payload 是 server 推还是客户端算。不做这个验证就不能宣称甜头成立。

**结论**：08-07 §6 的甜头前提（`kscc --experimental-acp` 推 context usage）随 kscc 拆 ACP **已失效**；ksoc 路线能否拿到 context usage **存疑，需实测**。这是本篇最重要的发现——当初评估里最大的收益项，现在连存不存都打问号。

---

## 5. 综合判定：比 08-07 当初评估的更不值得投入

| 评估项 | 08-07 当初（kscc --experimental-acp） | 本篇（ksoc 路线） |
|---|---|---|
| 能不能做 | 能（§8 有移植清单） | 能（ksoc 现成），但 kscc 路已死、只剩 ksoc 路更重 |
| 甜头 1：context usage | 协议级精确（§6） | **存疑**（§4，ksoc grep 0 命中） |
| 甜头 2：协议字段稳态 | 薄（envelope 漂移面小） | 同薄（且 opencode 升级风险新增） |
| 甜头 3：运行时换模型 | 有需求否未定 | 同 |
| 代价：丢 resume 长驻 | 丢 701ms 复用 + SDK cache | 同丢，opencode session 能否替代待验证 |
| 代价：传输架构 | stdio→？（08-07 未细说） | **stdio→TCP/SSE**（架构级，§3） |
| 代价：分发 | spawn 系统 kscc 即可 | **ksoc 藏在 KCwork 目录，分发坎**（§3） |
| 代价：一次性回归 | 有 | 更大（换后端 + 换协议 + 换传输） |

- **净判**：甜头最大项（context usage）存疑 + 代价更大（换后端 + TCP + 分发）+ 丢 resume 依旧 → **比当初评估的更不值得投入**。用户 08-17 的记忆「ACP 接入收益不如投入」不仅成立，在 ksoc 路线上更甚。
- **唯一可能翻盘的条件**：实测 ksoc 真能协议级推 context usage（§4 未做的前置验证）。若能，甜头回归，值得重评；若不能，就此搁置。

---

## 6. 与凭证备选路线的关系

| | 本篇（ksoc ACP 路线） | `2026-08-17-kscc-account-failover-research.md`（凭证备选） |
|---|---|---|
| 层次 | 协议/后端层 | 凭证层 |
| 动作 | 换后端 CLI（kscc→ksoc）+ 换协议（stream-json→ACP）+ 换传输（stdio→TCP） | 不换后端/协议，只换账号 sk |
| 工程量 | 架构级 | 轻量（env 注入 + b64 解码） |
| 收益 | context usage（存疑）+ 协议稳态（薄） | 配额池扩到账号 B（确定） |
| 风险 | 大（回归 + 分发 + 丢 resume） | 小（依赖 KCwork b64 格式） |
| 现状 | 不值得（待 context usage 实测翻盘） | 已实测可行，待工程化 |

- 两篇正交：凭证备选解决「配额不够」（确定、轻），ksoc 路线解决「想要 context usage / 协议稳态」（重、存疑）。
- 若用户诉求是**配额**，走凭证备选那条，别碰 ksoc。
- 若用户诉求是**context usage**，先做 §4 前置验证再决定，别先投入改造。

---

## 7. 三篇调研关系总览

```
08-07 kcwork-kscc-acp-research     证：旧版 KCwork spawn kscc --experimental-acp；ACP 甜头=context usage（前提）
  └─ §11（08-17 复核）              证：kscc 1.2.1 去 ACP → 「kscc 转 ACP」计划作废
       ├─ 08-17 kscc-account-failover  证：凭证层可切账号（已实测），不碰 ACP
       └─ 本篇 ksoc-acp-route          证：ACP 没死，换 ksoc 跑；但甜头存疑、代价更大
```

- 08-07 §11 的「ACP 死路」结论需修正：死的是「**kscc 这条 ACP 路**」，不是「ACP 接入 TAgent」整体——ksoc 是另一条活路。
- 本篇不推翻 08-07 §11 的「不可劫持」结论（那是进程/接管层），只补「ACP 还有 ksoc 路线」这一支。

---

## 8. 后续动作

- [ ] **前置验证（决定性）**：实跑 `ksoc acp --port 0` + ACP 客户端连上，观察是否真收到 `acp_context_usage` 事件 + payload 来源（server 推 vs 客户端估算）。不做此验证不投入改造。
- [ ] 若 §8 前置验证为「能协议级推」→ 重评 ksoc 路线价值，出实施计划（ACP 客户端 + TCP 传输 + ksoc 分发）
- [ ] 若「不能 / 是估算」→ ksoc 路线搁置，维持现状；配额需求走凭证备选
- [ ] 修正 08-07 文档 §11 措辞：「ACP 死路」→「kscc 这条 ACP 路死，ksoc 路另算」（指向本篇）

---

## 附录：取证命令（可复现）

```bash
# ksoc help（git-bash fork 失败时用 python subprocess 绕开，输出含盲文制表符会炸 GBK 终端，需过滤）
python -c "import subprocess,re; r=subprocess.run([r'D:/Program Files/KCwork/resources/bundled-aioncore/win32-x64/managed-resources/cli/ksoc/1.0.6/win32-x64/bin/ksoc.exe','--help'],capture_output=True,timeout=8); print(re.sub(r'[^\x20-\x7e\n]','',r.stdout.decode('utf-8','replace'))[:2500])"

# ksoc acp 子命令
# 同上换 'acp','--help'  → 见 §1 传输选项

# grep ksoc.exe 关键字（见 §2/§3/§4 代码：分块读 48MB + 滑窗 200KB 防跨块漏匹配）
# grep app.asar 关键字（同法，336MB）

# 命门实测 kscc 账号 B（见 account-failover 文档附录 A，本篇不重复）
```

- 本机 git-bash 持续 fork 失败（Exit 5，memory `windows-git-bash-sandbox-fork`），全程用 `python subprocess` 绕开。
- ksoc help 输出含 opencode 主题盲文/制表符，直接 print 到 GBK 终端会 `UnicodeDecodeError`，需 `re.sub(r'[^\x20-\x7e\n]','')` 过滤。

---

## 9. 最终判定（2026-08-17 定论，经系列讨论收敛）

> 本节是三篇调研（08-07 / 08-17 failover / 本篇）讨论后的**结论落档**，供后续直接引用，不必再回溯推理过程。

### 9.1 TAgent kscc 核 = KCwork 内部 kscc 用法（同款，已核实）

- **核实证据**：`apps/electron/src/main/lib/adapters/claude/spawn-kscc.ts`（:8/:27 用 `@anthropic-ai/claude-agent-sdk` 的 `SpawnOptions`，args 由 SDK 生成）+ `claude-agent-adapter.ts` 的 `KsccQueryOptions.resumeSessionId`；grep `--bare`/`--max-turns`/`--tools ""` 在 spawn-kscc.ts **零命中**。
- **判定**：TAgent kscc 核走 **SDK 驱动 + `--resume` + stream-json**；KCwork 内部用 kscc 同款（08-07 §2.1 从 KCwork asar 扒出的即此）。**一模一样，非 bare**。
- **身份**：TAgent 是**外部集成者**，走 kscc 这条金山云**留给外部程序的接入口**（非劫持）；KCwork GUI 内部另用 ksoc/ACP 是其通用壳需求，与 TAgent 定位无关。
- **撤回前误**：调研中途曾误读 `packages/pi-core/src/kscc-spawn.ts` 的 `spawnKsccBare`（pi-core 的可选 bare 泵 stream fn）为 TAgent kscc 核主路，并据此臆造「比官方更激进」论点——**作废**。pi-core bare 泵不是 kscc 核主路。

### 9.2 不需要 ksoc（对 TAgent 定位与目标，税白付）

理由不是「ksoc 不好」，是**身份不匹配 + 甜头不实**：
1. **身份不匹配**：ksoc 是 KCwork GUI 内部的多后端通用壳基座（挂 N 种 CLI 当主引擎）；TAgent 是外部集成者，目标是接金山云免费模型——kscc 够，不需要通用壳的税。
2. **甜头未证实**：ksoc/ACP 唯一可能的账面优势（context usage 精确）在 ksoc.exe grep `acp_context_usage` **0 命中**（§4），server 侧没证实推送。用确定的损失换不确定的收益，不值。
3. **代价确定**：换 ksoc = 丢 SDK resume 的自动高命中 cache + stdio→TCP/SSE 架构级改 + ksoc 分发坎（藏 KCwork 目录，非系统 PATH）+ 大回归。全是为「多后端当主引擎」这个 TAgent 不需要的能力付的税。

### 9.3 不改方向（两层都要讲清，免混淆）

- **主后端层**：维持 kscc（SDK + resume + stream-json），**不换 ksoc/ACP**。此条定。
- **子代理层**（`runCliWorker` 挂 codex/grok/mimo/claude 等，`apps/electron/.../cli-workers/`）：那套 stdio + N-observer（每 CLI 一个 StreamObserver）是 TAgent 已有的多 CLI 能力，**与 ksoc/ACP 无关，也别动**——短任务 stdio 比 ACP 更优（ACP 起 server + 握手对一次性短任务过重）。

### 9.4 活口（未来若需求变，先实测再定，勿直接改方向）

本结论建立在「context usage 在 ksoc 上未证实」前提上。若未来真要 context usage：
- **先做决定性实测**：起 `ksoc acp --port 0` + ACP 客户端连上，观察是否真收到 `acp_context_usage` 事件 + payload 来源（server 推 vs 客户端估算）。见 §8。
- 推 → 重评 ksoc 路线价值；不推 → 维持现状。
- 此为「未来若需求变」的活口，非「现在留疑」——**现在不改方向是确定的**。

### 9.5 三篇调研关系（定论后）

```
08-07 kcwork-kscc-acp-research     旧版 KCwork spawn kscc --experimental-acp；ACP 甜头=context usage（前提）
  └─ §11（08-17 复核）              kscc 1.2.1 去 ACP → kscc 这条 ACP 路死（≠「ACP 整体死」，见本篇 §9.5 修正）
       ├─ 08-17 kscc-account-failover  凭证层可切账号（已实测），不碰 ACP
       ├─ 本篇 ksoc-acp-route          ACP 还有 ksoc 路；但对 TAgent 甜头存疑、代价大
       └─ 本篇 §9 最终判定             TAgent kscc = KCwork 同款；不需要 ksoc；不改方向
```

### 9.6 待修历史措辞

- 08-07 文档 §11 措辞「kscc 去 ACP → ACP 死路」需修正为「**kscc 这条 ACP 路死；ksoc 是另一条 ACP 路，但对 TAgent 不值得（见本篇 §9）**」。见下节 §10。

---

## 10. 多 CLI 当主会话基座：路线对比与 cache 命中命门（2026-08-17 续论）

> **状态：待定（2026-08-17）**——经讨论判定此模块实现费劲（多路线选择 + cache 命中命门 + 线性 adapter 成本），暂不投入；优先转向本地 CLI 子代理优化（见 `2026-08-17-ksoc-acp-route-research.md` 本节为决策存档，实施待后续重启）。
>
> 本节承接 §9 定论后的新问题：「把 TAgent 当成多家 CLI 的主会话基座（不只 kscc，还想让 grok/claude code/codex 当主基座），是不是只能自己写每个 CLI 的适配层？ACP 通用协议能否省掉这些适配层？」结论：**不止一条路，但对贵模型基座，N-adapter 反而比 ACP 更省**——cache 命中这关让 ACP 在贵模型场景反向。

### 10.1 现状：主会话基座只有两核，CLI 目前只当子代理

- `adapters/index.ts:23` `ChannelKind = 'kscc' | 'external'`——主会话基座两核：`ClaudeAgentAdapter`（kscc 核，SDK+resume+stream-json）与 `PiAgentAdapter`（pi 核，http 直连或 kscc bare 泵）。`getAdapter(kind)` 二选一。
- CLI（codex/grok/mimo/opencode/claude）目前**只通过 `subagent-task-tool` 当子代理后端**（`resolveTaskSubagentBackend` → `runCliWorker`），**不进主会话**。
- 子代理层已有 `run-grok-worker`/`run-claude-worker`/`run-codex-worker`/`run-mimo-worker`/`run-opencode-worker` + 各自 `StreamObserver`（输出转译层已存在）。**缺的只是把这些 CLI 从子代理提升到主会话基座**——即主会话生命周期管理 + 各 CLI 的 resume 适配。

### 10.2 三条路线对比

| 路线 | 要 ACP | 机制 | 省什么 | 代价 |
|---|---|---|---|---|
| **A. N-adapter** | 不要 | 仿 `ClaudeAgentAdapter`，每 CLI 写一个 adapter（spawn CLI 跑完整 agent + 各自原生 resume + 复用已有 StreamObserver 转译输出） | 保各 CLI 原生 resume + cache 命中；CLI 池不限（grok/mimo 也能接） | 线性开发成本（接 N 个写 N 套）；随 CLI 升级漂移维护 |
| **B. ACP 统一客户端** | 要 | 写一个 ACP 客户端，连各 CLI 的 ACP server，统一接所有 ACP-compliant CLI | 省掉 N 个 adapter（一个客户端接所有） | 限有 ACP 的 CLI（ksoc/claude 有，grok/mimo 无）；丢 SDK 自动 cache 命中；stdio→TCP/SSE；贵模型费钱（见 §10.3） |
| **C. 混合** | 部分 | 有 ACP 的 CLI（ksoc/claude/codex 待验）走 ACP 客户端；没 ACP 的（grok/mimo）走 adapter 或保持子代理 | ACP 免付一次客户端成本，接住所有有 ACP 的；没 ACP 的不硬套 | ACP 那批的 cache 命中问题仍在（§10.3）；两套并存复杂度 |

### 10.3 cache 命中命门（贵模型场景的拦路石）

- **kscc 核 resume**：SDK 进程内维护 prompt cache，下一轮只发增量，命中 cache 省 ~90% input token——这是用贵模型能扛长会话的命根子。
- **ACP 无状态**：协议层无「自动 cache 命中」。续跑靠各 CLI 自己的 session（claude code `--resume` 能续，但续跑质量/cache 命中是 CLI 自管，非 ACP 保证）；或手动重放。
- **后果**：对 claude code/codex 这种按 token 计费的贵模型，无可靠 cache 命中 = 长会话费用灾难。**ACP 省了 N-adapter 的一次性开发费，却可能在运行成本（每会话 token 钱）上反向**。
- **关键反转**：贵模型场景下，**N-adapter 保原生 resume/cache 反而比 ACP 更省**——省的是真金白银的运行成本，不是工程费。ACP 的甜头在便宜/免费模型池（ksoc/glm），不在贵模型。

### 10.4 最终判定

- **不止一条路**：N-adapter（A）/ ACP（B）/ 混合（C）三选一，非「只能写每个适配层」。
- **贵模型基座（claude code/codex）→ N-adapter（A）更优**：保 cache 命中省运行费，CLI 池不限；开发成本是一次性，token 费是每次会话。
- **便宜/免费模型池（ksoc/glm/kimi）+ 多 CLI + 不在乎 cache → ACP（B/C）值得**：运行费本就低，省开发费划算。
- **临界点**：CLI 数量 × ACP-compliance 比例 × 模型单价。想接的 CLI 多数有 ACP 且便宜、数量≥3 → ACP；多数没 ACP 或是贵模型 → N-adapter。

### 10.5 分层建议（不二选一）

- **有 ACP 的便宜模型 CLI（ksoc/claude code 的免费层）** → 写一个 ACP 客户端接（省 adapter）。
- **没 ACP 的 CLI（grok/mimo）** → 复用子代理层 StreamObserver，写 adapter 或保持子代理。
- **贵模型（claude code/codex 付费层）当主基座** → N-adapter 保原生 resume/cache，别走 ACP。
- 子代理层（`runCliWorker` stdio+N-observer）保持不变，与主会话基座是两件事，别混改。

### 10.6 前置实测（决定性，先做再投入任何路线）

1. **ACP 握手 + 主会话跑通**：起 `ksoc acp --port 0` + ACP 客户端连上，跑通一个主会话（不只是子代理短任务），证明 ACP 在本机真活。
2. **cache 命中实测**（贵模型场景命门）：用 claude code 的 ACP 适配器跑 10 轮长会话，对比 ACP 续跑 vs 原生 `--resume` 的 input token 消耗——命中差 → 贵模型场景 ACP 不可行；命中好 → ACP 可扩到贵模型。
3. 不做这两个实测不投入 ACP 改造；N-adapter 路线则先接一个目标 CLI（如 claude code）验证主会话生命周期 + resume 适配。

### 10.7 与 §9 定论的关系

- §9 定论（主后端维持 kscc、不改方向）**不变**——那是「主后端换 ksoc」的判定，针对为换而换的无收益场景。
- 本节是**新场景**（多家 CLI 当主基座）的判定，与 §9 正交：§9 说「现有 kscc 核别动」，本节说「若新增多 CLI 主基座，贵模型走 N-adapter、便宜模型走 ACP」。
- 两处不冲突：§9 守住现有主后端，本节指导未来扩展方向。


