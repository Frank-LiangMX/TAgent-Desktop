# KCwork 反代 / kscc 核改造可行性调研

> **状态**：调研结论（2026-08-07），未动工
> **触发**：用户想确认 kscc 出的桌面 agent「KCwork」能否给 TAgent 提供更稳定的调 kscc 思路
> **结论先行**：KCwork 调 kscc 的方式 = spawn kscc CLI 进程（ACP 协议）+ utility worker 双层隔离，与 TAgent 的 spawn kscc 同源同路；**不是 http 反代、不是 API key 直连**。能给 TAgent 的实际收益有三块（context usage / 崩溃隔离 / 协议稳态），但都不解决"两核重复维护"的真痛点。是否动工取决于对这三块收益的取舍。
> ⚠️ **2026-08-17 实测复核**：§2.2「spawn `kscc --experimental-acp`」前提已失效（终端 kscc 1.2.1 移除 ACP）；KCwork 8月14新版自包含 ksoc/aioncore，不再依赖系统终端 kscc。详见末尾 §11。
> ⚠️ **2026-08-17 定论修正**：§11「kscc 去 ACP → ACP 死路」措辞需窄化为「**kscc 这条 ACP 路死**」——KCwork 改用自带 ksoc（opencode 改造版，带 `opencode acp`）跑 ACP，是另一条活路；但对 TAgent 定位不值得（甜头 context usage 未证实 + 代价大）。详见 `2026-08-17-ksoc-acp-route-research.md` §9 最终判定。

---

## 0. 一句话脉络

用户问「KCwork 能否反代」→ 解包 KCwork asar 发现它根本不是反代，是 spawn kscc CLI → 用户纠正「我 kscc 核也不是反代，是 spawn kscc CLI 转译」→ 焦点变成「KCwork 调 kscc 的方式能否比 TAgent 现有 spawn+转译更稳」→ 挖出 ACP 协议 + fork worker 双层隔离 + context usage 协议字段三个差异点 → 实测网关 http 直连被 403 掐死 → 落盘待决策。

---

## 1. KCwork 是什么（解包实证）

- **本体**：开源项目 **AionUi**（GitHub `iOfficeAI/AionUi`，Apache-2.0）的金山云发行版。
  - 证据：`resources/app-update.yml` → `owner: iOfficeAI / repo: AionUi / publisherName: 北京金山云网络技术有限公司`
  - 安装路径：`D:\Program Files\KCwork\`，Electron 应用，核心在 `resources/app.asar`
- **package.json 关键依赖**：
  - `@anthropic-ai/claude-agent-sdk@0.2.137` + `@anthropic-ai/sdk@^0.71.2`（进程内 SDK）
  - `@agentclientprotocol/sdk@0.18.2`（ACP 客户端）
  - `@office-ai/aioncli-core@^0.30.6`（多鉴权 agent core，含 AuthType 枚举）
  - `@aws-sdk/client-bedrock` / `@google/genai`（多后端）
- **不是 Anthropic 的 Claude Cowork**（一度误判，已纠正）。

---

## 2. KCwork 怎么调 kscc（与 TAgent 对比）

### 2.1 三条调 LLM 的路

KCwork 内部对 Anthropic 协议有三条路（`out/main/chunks/index-D2s-N8xo.js`）：

1. **USE_ANTHROPIC（BYOK http 直连）**：`fallbackValue("ANTHROPIC_BASE_URL", getBaseUrl())` + `ANTHROPIC_API_KEY`，进程内 `@anthropic-ai/sdk` 直接 http。UI 有 "base url" 字段，`normalizeNewApiBaseUrl` 自动去 `/v1` `/v1beta` 尾斜杠。**这是真反代路径，但需要用户自带 key。**
2. **KSCC 网关（企业登录态）**：`buildAuthMeta` 的 `gateway` 方法 → `{ baseUrl, headers: { Authorization: Bearer ${sk} } }`（`index.js:16560`）。sk + baseApi + companyCode 落盘 `~/.claude/settings.json` + `AppData/Roaming/kcwork/kscc-credential.json`。
3. **ACP spawn CLI**：`conversation.type === "acp" && extra.backend === "kscc"`，spawn `kscc --experimental-acp`，走 `@agentclientprotocol/sdk` 通信。**这是 KCwork 调 kscc 的实际路径。**

### 2.2 kscc 渠道走 ACP（关键）

- 会话标记：`conversation.type === "acp" && extra.backend === "kscc"`（`index.js:44582/44634`）
- 启动参数：`DEFAULT_ACP_ARGS = ["--experimental-acp"]`（`index.js:12154`），claude/kscc 同协议同参数
- 通信：`@agentclientprotocol/sdk`，`backend.sendCommand("set_model", …)` 运行时换模型（`:44629`）
- spawn：`spawnGenericBackend`（`:14961`），全程 `[ACP-PERF]` 日志
- **kscc 渠道不直接发 http `/v1/messages`，而是 spawn kscc CLI 让 CLI 当客户端**——与 TAgent spawn kscc 同源。

### 2.3 ACP = Agent Client Protocol（科普）

- 一句话：把"一个 AI agent 进程"封装成有标准接口的服务，让任何客户端能驱动它。类似 LSP 之于编辑器、MCP 之于工具。MCP 是"工具暴露给 agent"，ACP 是"agent 暴露给宿主"。
- 传输：stdio 或 websocket，JSON-RPC 风格。
- 核心事件：`session/update` 流式吐 `agent_message_chunk`/`agent_thought_chunk`/`tool_call`；`session/set_model` 运行时换模型；`session/command` 下指令；`onContextUsage` 推上下文占用；`onPermissionRequest` 权限回调。
- 关键好处：事件是**标准契约**，kscc 升级只要遵守 ACP spec，事件形状不变；不用追 kscc 内部 stream-json 格式改转译。

---

## 3. 网关 http 直连实测（403 掐死）

### 3.1 凭证落盘

KCwork 登录后 sk 明文落在 `~/.claude/settings.json`：

```json
"env": {
  "ANTHROPIC_AUTH_TOKEN": "sk-lSkd4HdytpHaJtHr3oCgF8fCtoQWb0rIr_z7Gc3SImzjcz8",
  "KSCC_AUTH_TOKEN": "sk-YRj3O4tLH-N-3m_HLYEoT3BbHyFi9c_A1Ra4avZeRl7SknA"
},
"BASE_API": "http://120.92.138.34",
"ksccModel": "glm-5.2"
```

`~/.claude/settings.json` 是 kscc CLI 的通用约定——任何程序 spawn kscc 都读同一个文件。KCwork 不拦、网关不分调用方。

### 3.2 实测结果（curl 直连 `http://120.92.138.34`）

| 端点 | 带头 | 结果 |
|---|---|---|
| `/` 根 | - | 404（端口通） |
| `/cli/models` | `Authorization: Bearer sk` + `client: kscc-cli` | **200 + 模型列表**（glm-5/5.1/5.2/kimi-k2.5/k2.6/mimo-v2.5/pro） |
| `/cli/models` | 仅 `Authorization`（无 client 头） | **200**（client 头不校验） |
| `/v1/messages` | `Authorization` + `anthropic-version` | **403 `ClientForbidden`：禁止访问:客户端禁用，请联系管理员** |
| `/v1/messages` | + `client: kscc-cli` | **仍 403** |

### 3.3 结论

- **sk 有效**（能拉模型列表），但 **`/v1/messages` 有客户端指纹校验**，非 kscc CLI 进程的直连被挡。
- `/cli/models` 不挡因为只读、不烧配额。
- **"http 直连免费模型"这条路被网关掐死**——用户记忆里的"会被拦截"即此。pi 核 `createHttpDirectStreamFn` 直连此网关不可行。
- 推断：网关认"是不是 kscc CLI 发的"（出站特征/指纹），不认 sk 本身。所以**必须 spawn kscc 进程**，bare/resume/ACP 皆是。

---

## 4. kscc 在 TAgent 里是"进程"还是"API key 的感觉"

**始终是进程，不是 API key 直连。** 两条路彻底分开：

| | 进程模式（bare / resume / ACP） | API key 感觉（pi 核 http 直连） |
|---|---|---|
| 形态 | 长驻 Node 进程，stdin/stdout 管道 | 无进程，一次 HTTP 请求一次响应 |
| agent loop | kscc 内部跑（维护状态/调工具/解析结果/resume cache） | TAgent 自己写工具循环 |
| 主动性 | 主动（自己决定调工具/跑几轮/何时停） | 被动（给 messages 返回生成） |
| sk 角色 | 进程启动时过鉴权，存活期间不参与每轮 | 每次请求都带，请求级凭证 |
| 网关 | ✅ 放行（kscc CLI 客户端） | ❌ 403（非 kscc 客户端） |

**只要网关只放行 kscc 进程（实测如此），就甩不掉进程；能选的只是进程说哪种协议。** ACP 不改变"进程"本质，只改进程对外说话的格式。

---

## 5. TAgent 现有 kscc 核 vs KCwork ACP 架构对比

### 5.1 TAgent 现状

- **pi 核**（`packages/pi-core/`）：`@earendil-works/pi-agent-core`，主进程内存 agent，`createHttpDirectStreamFn`（外部渠道 http 直连）+ `createKsccBareStreamFn`（kscc bare spawn）双模式。
- **kscc 核**（`apps/electron/src/main/lib/adapters/claude/claude-agent-adapter.ts`）：spawn `kscc --resume` 长驻进程，`--output-format stream-json`，`kscc-ndjson-parser.ts` 转 Anthropic 原生流 → Pi IR。ADR-0002 实测 701ms 复用、SDK 自管 resume cache。
- **双核并存的真因**：后端不同。kscc 核白嫖 kscc CLI 免费国产模型（glm/kimi/mimo）；pi 核接用户自带 key 的付费/自定义渠道。**不是实现方式之争，是后端之争。**
- **bare（`kscc-spawn.ts`）用 `--bare`，主线 resume 用 `--resume`**——两者都 spawn kscc 走 stdio，都吃 kscc CLI 鉴权过 `/v1/messages`。"必须 spawn"对 resume 同样成立。

### 5.2 KCwork 多进程架构

- **每个会话 = 一个 utility worker（fork）**：`BaseAgentManager extends ForkTask`，`platform.worker.fork(type+".js")` 给每会话 fork 一个 Electron utility 进程（`index.js:38247`）。主进程 fork worker，worker 里再 spawn kscc——**双层隔离**。
- **主进程只做消息路由**：`Map<conversationId, AgentManager>`，每 manager 持 `fcp`（forked child），`postMessagePromise` 走 IPC（`send.message`/`stop.stream`/`complete`）。`KsccAgentManager`/`AcpAgentManager`/`OpenClawAgentManager` 统一 `BaseAgentManager` 接口。
- **进程粒度 = 会话粒度**：一会话一 worker + 一 kscc，会话关 = 进程 kill，`process.on("exit", killFn)` 兜底全杀。**无进程池/LRU/上限计数器**——与 ADR-0002 "标签页=进程、无 idle 计时器、上限靠标签数自然管控"同哲学。
- **`CronBusyGuard`**（`:38063`）：会话级忙闲态，同会话不并发两条消息（`states` Map + `onceIdle` 排队），**不是多会话并发控制**。

### 5.3 三方对比

| 维度 | TAgent 现状（resume 长驻） | KCwork（fork worker + ACP） |
|---|---|---|
| kscc 进程位置 | 主进程直接 spawn | utility worker 里再 spawn（双层） |
| 多会话 | 每会话一 kscc 进程，主进程直管 | 每会话 fork worker，worker 管各自 kscc |
| 协议 | stream-json（Anthropic 原生流 + 薄 envelope） | ACP（标准事件 + `onContextUsage`） |
| context usage | ❌ 拿不到（已砍掉） | ✅ kscc 主动推 `{used, size, cost}` |
| 主进程压力 | N 个 kscc stdio 压主进程 | N 个 worker IPC，kscc 与主进程隔离 |
| 崩溃隔离 | kscc 崩可能波及主进程 | worker 崩只死那个会话 |
| resume 长驻 | ✅ SDK 自管，701ms 复用 | ❌ ACP 无状态，需自建 |

---

## 6. context usage 痛点专项（这是 ACP 唯一实打实的甜头）

### 6.1 为什么 TAgent 拿不到

- `kscc-ndjson-parser.ts:110` 只能从 `result`/`message_delta` 捞 `usage.input_tokens`/`output_tokens`/`cache_*`——**单次请求 token 计数**，非上下文占用百分比。
- 缺分母 `size`：只有 kscc 进程自己知道当前会话真实 context window（glm-5.2 1M / mimo 1M / kimi 262k，随 resume/cache 动态变）。TAgent 外部拿不到，只能硬编码模型 max_tokens 估，估错即废。
- **用户因此砍掉了 kscc 渠道 context 统计**——砍得对，stream-json 这条路确实给不出准确值。

### 6.2 KCwork 怎么拿

- ACP 客户端注册 `onContextUsage(usage2)` 回调（`index.js:36985`），kscc 进程**主动推** `acp_context_usage` 事件，data `{ used, size: total, cost }`。
- `size` = 当前会话真实容量上限，`used` = 真实占用，kscc 进程内部精确算好推给客户端。百分比 `Math.round(u.used / u.size * 100)`（`:17260`）。
- **这是协议级字段，不是从 token 算出来的**——stream-json 拿不到，ACP 才有。

### 6.3 诚实评估

- 转 ACP 的甜头：**context usage 回来**（实）+ 转译不再追 kscc 内部格式漂移（薄，envelope 漂移面极小，pin 住 kscc 1.1.28 不动）+ 运行时换模型（你无需求）。
- 代价：**丢 resume 长驻**（ACP 无状态，701ms 复用 + SDK resume cache 得重建）+ `--experimental-acp` 是实验旗（你现在才是稳态主路）+ 一次性回归风险。
- **ACP 解决不了"两核重复维护"**——两核存在因后端不同，ACP 不 merge 后端，只改 kscc 核内部说话格式。能解两核的唯一动作是 http 直连免费模型，而那被网关 403 掐死。

---

## 7. 决策矩阵（待用户拍板）

| 诉求 | 动作 | 收益 | 代价 |
|---|---|---|---|
| 要 context usage 回来 + 接受重建 resume | kscc 核整体转 ACP | context usage 精确 + 协议字段全 + 崩溃隔离（若同时上 fork worker） | 丢 resume 长驻 + 实验旗 + 一次性回归 |
| 只要崩溃隔离，不碰协议 | 主进程 spawn 改 fork worker 包 kscc | kscc 崩不波及主进程 | 双层 fork 对单 kscc 取向过度设计；context usage 仍拿不到 |
| 减两核重复维护 | IR 下沉，两核共用一套 IR | 重复维护减半 | 不动 kscc 调用方式；改动面在 shared 层 |
| 不动 | 维持现状 | 0 风险 | context usage 永缺；崩溃隔离弱 |

**关键前置验证（未做）**：kscc ACP 模式是否保留 resume 续跑语义。`--experimental-acp` 下 `--resume <sid>` 还活不活——保住则 ACP 净赚（context usage 回来且不丢长驻）；保不住则得用"自管上下文"换"usage 精确"。

---

## 8. 可移植清单（若决定转 ACP）

1. `kscc-spawn.ts` 的 `--bare --stream-json` 换 `--experimental-acp`
2. 删 `kscc-ndjson-parser.ts` 手写 Anthropic 转译，改接 ACP 事件（KCwork `AcpAdapter` 有现成 `agent_message_chunk`/`agent_thought_chunk`/`tool_call` 映射可抄，`index.js:39552`）
3. 引 `@agentclientprotocol/sdk@0.18.2` 做 ACP 客户端，注册 `onContextUsage` 拿 context usage
4. 鉴权/免费模型照旧：ACP 模式 kscc 仍自管鉴权，`~/.claude/settings.json` 的 sk 仍由 kscc CLI 自读，1.0「不碰 sk」约束不破
5. 若要崩溃隔离：把 spawn 从主进程移到 fork 的 utility worker

---

## 9. 合规边界

- KCwork 落盘 sk 是 kscc CLI 通用机制，TAgent spawn kscc 同样读这文件——1.0 刻意「不存 sk、由 kscc CLI 自管」是为避开「非官方客户端持有企业凭证」的顾虑。
- 借用落盘 sk 做 http 直连（不 spawn）= 从「调用官方 CLI」滑向「持有企业 token 直连网关」，但网关 403 已掐死此路，无需纠结。
- spawn 模式（含 ACP）保持「kscc 自管鉴权、TAgent 不主动读 sk」，合规边界不变。
- 公司网关侧把 TAgent 调用算在那张 sk 的账上；若公司 ToS 禁第三方客户端则有风险，需确认。

---

## 10. 后续动作

- [ ] **前置验证**：实跑 `kscc --experimental-acp`，确认 ACP 握手 + 是否保留 resume 续跑（决定 §7 取舍）
- [ ] 用户拍板诉求优先级（context usage / 崩溃隔离 / 减重复 / 不动）
- [ ] 拍板后按 §8 出实施计划

---

## 11. 2026-08-17 实测复核（§2.2 / §8 前提过时，结论：终端 kscc 无法劫持 KCwork）

> 触发：用户问「终端 kscc CLI 能否劫持系统已安装的 KCwork」。复核发现 08-07 调研的多条前提已被版本演进推翻，劫持在四条路径上均走不通。本节只读取证、未动业务码。

### 11.1 kscc 1.2.1（原钉 1.1.28）已移除 ACP
- `kscc --experimental-acp` → `error: unknown option '--experimental-acp'`（实测）。
- `kscc --help`（229 行）全文无 acp/experimental/protocol；子命令仅 `agents / auto-mode / doctor / gateway / install / mcp / plugin / project / setup-token / ultrareview / update`，**无 `acp`**。
- → §2.2「KCwork spawn `kscc --experimental-acp`」对当前终端 kscc 不再成立；§8 可移植清单第 1 条（`--bare --stream-json` 换 `--experimental-acp`）失去前提。

### 11.2 KCwork 8月14 新版已全自包含，不再依赖系统终端 kscc
安装路径 `D:\Program Files\KCwork\`，`app-update.yml` → `owner: iOfficeAI / repo: KCwork`（已从 AionUi 独立为 KCwork 仓库）；`resources/` 新增三块自包含件：

| 件 | 实测 | 作用 |
|---|---|---|
| `bundled-aioncore/win32-x64/aioncore.exe` | 93MB，`aioncore 0.0.1`，ks3 CDN（`fe-frame.ks3-cn-beijing.ksyuncs.com/kscc/aioncore/...`） | KCwork 自带 ACP 宿主主进程 |
| `managed-resources/cli/ksoc/1.0.6/.../bin/ksoc.exe` | `1.0.6`（**非**系统 `kscc` 1.2.1，独立 ksoc 二进制） | KCwork 自带 CLI，不 spawn 系统 kscc |
| `managed-resources/node/node-v24.11.0-win-x64` | 自带 node 24.11 | 跑 ACP 适配器（bunx） |
| `hub/aionext-*.zip` | 扩展市场：auggie/claude/codebuddy/codex/goose/opencode/qwen | ACP 适配器按需装 |

- `hub/aionext-claude` 实测：`defaultCliPath: "bunx @agentclientprotocol/claude-agent-acp"`，`cliCommand: "claude"`，`acpArgs: []`；`scripts/install.ts` 用 `bun install @anthropic-ai/claude-code @agentclientprotocol/claude-agent-acp`（多镜像源回退）+ 软链 `bin/claude` → `.bin/claude-agent-acp`。
- → KCwork 调 Claude/kscc 渠道改走「aioncore 宿主 + npm 封装的 ACP 适配器」stdio，**不再依赖系统终端 kscc 是否带 ACP flag**。

### 11.3 凭证仍共享，但不是劫持点
- `~/.claude/settings.json` 实测仍含 `ANTHROPIC_AUTH_TOKEN` + `KSCC_AUTH_TOKEN` + `BASE_API=http://120.92.138.34`，`ksccModel` 现为 `deepseek-v4-flash`（08-07 记录为 glm-5.2）。
- 此为 kscc-CLI 通用约定，终端 kscc 自己读、自己过网关指纹校验；KCwork 无法吊销或 gate 终端 kscc 的访问。共享凭证 ≠ 劫持入口。

### 11.4 四条"劫持"路径全部走不通
1. **接管运行中会话**：KCwork↔aioncore↔适配器是私有 stdio 父子管道，无网络端点可从外部 attach。
2. **PATH 重定向让 KCwork spawn 终端 kscc**：KCwork 适配器期望 ACP 握手，终端 kscc 1.2.1 不讲 ACP → 握手即败。要救只能再套 `@agentclientprotocol/claude-agent-acp`（那是用 ACP 封装，非劫持）。
3. **夺凭证**：本就不需要——终端 kscc 直读 settings.json 即过网关，KCwork 无法 gate。
4. **借 KCwork 当子代理后端**（对应 F1 缺口）：KCwork aioncore 是常驻 ACP 宿主 + 会话管理器，非可一次性 spawn 喂 prompt 收 ndjson 的 CLI 形状，与 TAgent `runCliWorker`（`run-cli-worker.ts` 的 kscc/grok/codex/mimo/opencode/claude runner）模型对不上；KCwork 自带 ksoc 也不暴露给外部 spawn。

### 11.5 净判
- 终端 kscc 与 KCwork 比 08-07 文档写的**更解耦**：KCwork 走自带 ksoc + aioncore + npm-ACP 封装，终端 kscc 丢了 ACP。
- **无可劫持的依赖方向**（KCwork 已不依赖终端 kscc）、**无兼容的协议入口**（终端 kscc 无 ACP）、**无 KCwork 能 gate 的凭证**。
- 若目标是给子代理派工接线（F1），KCwork 这套自包含 GUI 栈帮不上；直连 `runCliWorker` 现有 runner 更对路。
- §7 决策矩阵中「kscc 核整体转 ACP」一行：前置验证（kscc ACP 是否保留 resume）已无需做——终端 kscc 无 ACP 可转；若仍想要 context usage，需另寻路径（非借 KCwork）。
