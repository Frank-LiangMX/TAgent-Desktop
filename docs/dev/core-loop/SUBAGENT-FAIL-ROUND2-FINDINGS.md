# 摸底 FINDINGS — haiku 修复后「子代理又失败」+ 其它问题（ROUND2）

> 输入：用户称 haiku 修复（`831c941`，2026-08-07 11:22）后「最新一轮会话子代理又失败，且好像还有别的问题」。
> 派工：本机 `kscc -p --dangerously-skip-permissions`。**只读摸底**，写 FINDINGS；不改业务代码、不 commit。
> 前序：`SUBAGENT-FAIL-FINDINGS.md`（ROUND1 根因 1/2/3）、`SUBAGENT-HAIKU-FIX-brief.md` / `-NOTES.md`（831c941 修法）。
> 本轮比前序 scout 多定位到 **GUI 真实落盘**（`~/.tagent-dev/projects/…`，前序 scout 找错成 `~/.tagent/projects` → 误判「面板落盘空白」），并补齐 `agent-sessions.json` meta、`8626f1b5` 基线、回归窗口、build-lag 推断。

---

## 0. 结论先行

1. **「子代理又失败」在最新会话里查无实据**。最新 GUI 会话（`session-1786070710143`，D--UnrealTagManager，08-07 11:11–11:46）**全程未派发任何子代理**——无 `Agent`/`Task` tool_use、无 `subagent_type`、无 `task_notification`。`executionMode=work`（Task 已注册，`session-service.ts:1146`），是模型**自己选择直接用 Glob/Read/Grep**，没委派。时间线里那些红字「失败」**全是 Bash 工具的 fork 报错**（`Exit code 5`），不是子代理卡（`SubagentEntryCard`）。
2. **真正的「别的问题」= Windows 下 Bash 工具 fork 失败**（主）。会话内 Bash 反复 `Exit code 5 … bash … C:\Program Files\Git\bin\..\usr\bin\bash.exe: *** fatal error - add_item ("\??\C:\Program Files\Git", "/", ...) failed, errno 1`，模型被迫改口「bash fork 失败（git bash 环境问题），改用 Glob 列目录」。与本机 [[windows-git-bash-sandbox-fork]] 同根，但**首次确认打到 GUI 主程序 Bash 工具**（不止 kscc CLI）。这才是用户在最新会话里看到的「失败」。
3. **haiku 修复在代码+工作树已生效，但运行时尚未验证**。`session-service.ts:1146` 确为 `buildBuiltinSubagentDefinitions(isClaudeAvailableForChannel(channel))`（注释 `1143-1145`，commit 831c941，18/18 单测绿 + typecheck OK）。但**没有任何「修复后」的子代理派发**可佐证：最新 GUI 会话始于 11:11（**早于** 11:22 提交）、无重启 → 跑在**旧构建**上；它又没派子代理。要坐实须 **rebuild + 重启**后开一个会触发委派的新 Work 会话。
4. **子代理在 kscc-internal/glm 渠道本就能跑通**。基线 `8626f1b5`（08-05，Work）派 3 个**小写** `explorer` 子代理，**跑在 `glm-5.2` 上、`toolUseResult.status=completed`**（`8626f1b5.jsonl:21/23/24`）——这是受 haiku 钉死影响的同一条 codepath（TAgent-Desktop `buildBuiltinSubagentDefinitions`），证明「继承父模型跑通」可复现，正是 831c941 要恢复的。另 `bbbde384`（08-04）的**大写** `Explore`/`Plan`（kscc CLI 自带 agent，非 TAgent-Desktop 角色）也全 `completed`（`bbbde384.jsonl:84-91/102-107/469-475/873-874`）——作「glm 渠道子代理能跑」的旁证，但大写 CLI agent 不走 haiku 钉死那条路，不构成反例。
5. **回归窗口**：haiku 钉死由 `620ed2e`（07-26，引入 `buildBuiltinSubagentDefinitions(true)`）+ `e495962`（08-03，引入 `claudeAvailable→haiku` 解析）叠加；`831c941`（08-07）拆除。注意 `8626f1b5`（08-05，**晚于** e495962）仍跑 `glm-5.2`（非 haiku）→ **运行构建落后于仓库 HEAD**（同因 → 831c941 多半也还没进运行中的 App）。
6. **AskUser 收口空 answers**（待证的「别的问题」候选）：`111ae17e.jsonl:109` `AskUserQuestion` → `:112` `The user did not answer the questions.` + `answers:{}`（**空**）。两种可能：① 用户没答（合法）；② TAgent-Desktop 的 H 移植（`canUseTool`→`updatedInput.answers`，见 [[regress-h-askuser-canusetool-not-controlframe]]，memory 称 General/SDK 0.3.185 已证）没把点选回灌 → SDK 视为未答。需用户确认「选项卡是否出现、是否点过」。不妄断 broken。
7. **流程瑕疵**（非会话异常，但影响排查）：
   - ROUND1 + 本轮前序 scout **找错落盘路径**：找 `~/.tagent/agent-sessions`（1.x 旧路）/ `~/.tagent/projects`（非 dev），2.0 dev 实际落 `~/.tagent-dev/projects/{workspaceId}/`（`session-store.ts:5` + `:15`「dev 模式共享 `~/.tagent-dev/`」）。故「面板落盘空白」是**假象**——会话在 `~/.tagent-dev/projects/D--UnrealTagManager/session-1786070710143.{jsonl,messages.jsonl}` 好好躺着。
   - 前序 scout 把 `111ae17e`（GUI 会话的 **SDK raw JSONL**）当成「子代理失败」会话——实为同一 GUI 会话的 SDK 副本（`agent-sessions.json` 里 `sdkSessionId` 前缀 `111ae17e`），里面只有 Bash fork 错、没有子代理。

> 一句话：**用户在最新会话里看到的「失败」是 Bash fork 报错，不是子代理；该会话根本没派子代理。haiku 修在代码里但还没被任何一次实跑验证（最新会话跑在旧构建、未重启、未委派）。**

---

## 1. 最新会话落盘定位

TAgent-Desktop GUI（2.0 dev）落盘在 `~/.tagent-dev/projects/{workspaceId}/`，**不是** `~/.claude/projects/`（那是 kscc CLI / SDK raw 日志）；也不是 `~/.tagent/agent-sessions`（1.x 旧路）或 `~/.tagent/projects`（非 dev）。

| 角色 | 路径 | mtime | 说明 |
|------|------|-------|------|
| GUI 会话（面板+SDK 持久化） | `~/.tagent-dev/projects/D--UnrealTagManager/session-1786070710143.jsonl`（+ `.messages.jsonl`） | 08-07 11:46:58 | 362894 B；经 REGRESS-G 落盘闸口过滤 |
| SDK raw JSONL（同会话） | `~/.claude/projects/D--UnrealTagManager/111ae17e-386b-4e3a-990d-74dd504c5a87.jsonl` | 08-07 11:46:58 | 406614 B；未过滤（比 GUI 副本多 ~44KB = 闸口丢的 partial 快照） |
| 会话索引 meta | `~/.tagent-dev/agent-sessions.json` → `session-1786070710143` | — | 见下 |

`agent-sessions.json` 里该条 meta（决定性）：
```json
{
  "id": "session-1786070710143",
  "title": "我在开发这个项目，但是之前的agent会",
  "mode": "general", "executionMode": "work",
  "permissionMode": "bypassPermissions",
  "channelId": "d284004d-3cb0-49b7-bd6f-e1114082e1a3",
  "modelId": "glm-5.2",
  "sdkSessionId": "111ae17e-386b-4e3a-990d-74dd5082e1a3",
  "turnCount": 2, "status": "idle",
  "turnDurations": { "1786070805081": {"ms":67607,"endedBy":"complete"},
                    "1786074418336": {"ms":220469,"endedBy":"complete"} }
}
```
- `executionMode:"work"` → Task/Agent **已注册**，模型本可委派，但没委派。
- `modelId:"glm-5.2"` = `KSCC_DEFAULT_MODEL_ID`（`default-models.ts:13`）→ 渠道 kscc-internal（非 Claude）。SDK JSONL 实测每条 assistant `model:"glm-5.2"`（`session-…0143.jsonl:2-63`、`111ae17e.jsonl:7-10`）。
- `sdkSessionId` 前缀 `111ae17e` = 上面 SDK raw 文件；**末 6 位 hex 与磁盘文件不一致**（索引 `…82e1a3` vs 磁盘 `…4c5a87`）——索引登记小瑕疵，但内容（glm-5.2 + 首句「先摸清项目现状与上次中断点」+「项目 UnrealTagManager — UE 5.8 资产标签管理插件」+ Bash fork 错）逐一比对，确系同一会话。
- 会话始于 11:11:50（id 末段 `1786070710143`ms），末轮 11:46:58 收口、`endedBy:"complete"`——**会话本身没崩**，Bash 失败是工具内失败、被模型绕开。

> 对照：`~/.claude/projects/` 里 08-07 当天的会话只有 `111ae17e`（= 上面 GUI 会话的 SDK 副本）与 `b3ddb8a3`（**haiku 修复的「实现」kscc 会话**，标题 `"Fix subagent haiku availability flag"`，首发消息就是 HAIKU-FIX brief）——都不是用户 GUI 用的「子代理又失败」会话。

---

## 2. 抽样：Agent/Task + task_notification + 子代理 model + 父会话 mode/渠道

### 2a. 最新会话（session-1786070710143 / 111ae17e）—— **无子代理**

| 项 | 证据 |
|----|------|
| `Agent`/`Task` tool_use | **0 命中**（`session-…0143.jsonl` 与 `111ae17e.jsonl` grep `"name":"(Agent\|Task)"`/`"subagent_type"`/`"task_notification"` 全空） |
| `task_notification` status/summary | **无**（无派发则无收口通知） |
| 子代理 model | N/A |
| 父会话 mode/渠道/model | `executionMode:"work"` / kscc-internal（`channelId d284004d…`）/ `glm-5.2`（索引 + JSONL 实证） |
| 实际工具 | Bash / Read / Glob / Grep / AskUserQuestion（`111ae17e.jsonl` 工具名分布；AskUserQuestion 在 `:109/111`） |
| 失败项 | Bash `Exit code 5` fork 错（`111ae17e.jsonl:9`×2、`:68`×2；`session-…0143.jsonl:9`、`:68`）；**无** `is_error` 来自子代理、**无** `"status":"failed"` 的 task_notification |

> 落盘闸口（`stream-persist-gate.ts`，REGRESS-G）**不会**吞掉 `Agent` tool_use：tool_use 是 assistant 非空 content 块，`isAssistantPersistable` 返回 true（`stream-persist-gate.ts:31-37`）→ 可落盘。故「无 Agent」是**真没派**，不是被闸口吃掉。

### 2b. 前序基线 8626f1b5（08-05，F--TAgent-Desktop，Work）—— **子代理跑通（同 codepath）**

`~/.claude/projects/F--TAgent-Desktop/8626f1b5-e3d9-4416-ad6c-50e95d6bed88.jsonl`：
- `:18/19/20` 三次 `"name":"Agent"` + `"subagent_type":"explorer"`（**小写 = TAgent-Desktop 内置角色**，受 `buildBuiltinSubagentDefinitions` / haiku 钉死影响——区别于 kscc CLI 的 `Explore` 大写）。
- `:21/23/24` 三条 `toolUseResult":{"status":"completed"`（时间 `07:15:33/35/52Z`）= 3 个子代理**收口 completed**。
- 子代理 `subagents/agent-a5d2278685aeae562.jsonl`：每条 assistant `"model":"glm-5.2"`（`:2-16`）、`stop_reason:"tool_use"`（`:9/:16`）、早段 `is_error:true`（`:19/:26`，子代理自己的工具错）后 `is_error:false`（`:35+`）→ **跑在 glm-5.2 上、调了工具、completed**。

### 2c. 旁证 bbbde384（08-04，D--UnrealTagManager）—— **大写 CLI agent 也跑通（不走 haiku 钉死）**

`~/.claude/projects/D--UnrealTagManager/bbbde384-….jsonl`：`Agent` × 多次，`subagent_type:"Explore"`/`"Plan"`（**大写 = kscc CLI 自带 agent**），`toolUseResult.status:"completed"`（`:90/91/107/475/874`），全 `glm-5.2`。→ glm 渠道子代理能跑的旁证；但大写 CLI agent 由 kscc CLI 自身定义、**不经** TAgent-Desktop `buildBuiltinSubagentDefinitions`，故不受 haiku 钉死影响，**不构成** haiku 钉死的反例。

> 实证：kscc-internal/glm 渠道下子代理**继承父模型 glm-5.2 即可跑通**（小写 GUI 角色与大写 CLI agent 均如此）。这既是 831c941 要恢复的行为，也反证 ROUND1 根因 1（钉 haiku）是这之后某构建引入的回归。

---

## 3. 对照 haiku 修：是否仍带 model:haiku？修是否生效？

| 问 | 答 | 证据 |
|----|----|------|
| 当前代码 agents 还钉 haiku 吗？ | **不钉**（kscc-internal 走 `false`） | `session-service.ts:1146` `buildBuiltinSubagentDefinitions(isClaudeAvailableForChannel(channel))`；`isClaudeAvailableForChannel`：仅 anthropic/anthropic-compatible 真（`default-models.ts`，commit 831c941）；kscc-internal → false → `resolveModelForRole` 返回 undefined → AgentDefinition 不带 model → SDK 继承父（`sdk-tools.d.ts:423`） |
| 工作树 = 提交版？ | **是** | `git status` 未列 `session-service.ts`/`default-models.ts` 改动 → 831c941 版即工作树版 |
| 修在运行 App 里生效了吗？ | **未知（倾向未生效）** | 最新 GUI 会话始于 11:11 < 11:22 提交、无重启 → 跑旧构建；且该会话未派子代理，无从佐证。`8626f1b5`(08-05) 晚于 `e495962`(08-03) 仍跑 glm-5.2 → 运行构建落后 HEAD → 831c941 多半也没进运行 App |
| 根因 1 排除了吗？ | **代码侧排除；运行侧待证** | 代码已不钉 haiku；但用户若未 rebuild+重启，运行 App 仍可能带旧逻辑 |

> 即：**修在仓库里、不在（大概率）运行进程里**。ROUND1 根因 1 的机理仍成立（钉 haiku → glm 网关不认 → 首轮 LLM 即败），只是当前最新会话没触发它。

---

## 4. summary/stderr → 根因 2（Windows 嵌套 spawn）？

- 最新会话**无 `task_notification`** → 无子代理收口 summary 可判；`[kscc stderr]` 主进程日志本机未抓（CLI 代理环境无 Electron 主进程 console）。
- 但会话里**确有 spawn 类失败**——只是发生在 **Bash 工具**，不是子代理：`Exit code 5` + `add_item ("\??\C:\Program Files\Git", "/", ...) failed, errno 1`（`111ae17e.jsonl:9/68`、`session-…0143.jsonl:9/68`）。这是 **git bash 自身 fork cygwin 堆失败**（与本机 [[windows-git-bash-sandbox-fork]] 一致），不是「子代理子进程 spawn 退出」。
- ROUND1 根因 2（子代理子进程 spawn）本轮**无新证据、未证实也未排除**——因为没有一次子代理派发可供观察。若将来在 kscc-internal 上 rebuild+重启后派子代理仍秒败，且 `[kscc stderr]` 是 `不是内部或外部命令`/`exit 1` 而非 model/API 报错，才坐实根因 2。

---

## 5. 「别的问题」逐条（同会话内，各一行证据）

| 类别 | 现状 | 证据 |
|------|------|------|
| **Bash fork 失败（主问题）** | ❌ 复现 | `111ae17e.jsonl:9/68`、`session-…0143.jsonl:9/68`：`Exit code 5 … add_item ("\??\C:\Program Files\Git","/",…) failed, errno 1`；模型自述「bash fork 失败（git bash 环境问题），改用 Glob」（`111ae17e.jsonl:18` / `session-…0143.messages.jsonl:11`） |
| **AskUser 空 answers（候选，待证）** | ⚠️ 待确认 | `111ae17e.jsonl:109` `AskUserQuestion` → `:112` `The user did not answer the questions.` + `answers:{}`（空）。① 用户没答（合法）或 ② Desktop 的 H 移植没把点选回灌 `updatedInput.answers`（见 [[regress-h-askuser-canusetool-not-controlframe]]，memory 称 General/SDK 0.3.185 已证，Desktop 对齐待证）。需用户确认选项卡是否出现/点过 |
| 思考消失（REGRESS-E/F） | ✅ 未复现（正向） | 思考链**有留存**：`session-…0143.messages.jsonl:10` `"thinking":"bash 命令出错了（fork 失败），但 Read 工具成功读取了 project-map.json…"` |
| 落盘（REGRESS-G） | ✅ 落了；闸口在干活 | GUI 副本 362894 B vs SDK raw 406614 B，差 ~44KB = 闸口丢的 partial 快照（`stream-persist-gate.ts:31-37` 只放行非空 content、去显式 `_partial`）。非 bug |
| 权限 | ✅ 无异常 | `permissionMode:"bypassPermissions"`；Bash 失败是 fork（exit 5）非「permission denied」 |
| 进度短文 / 编号层级 | ✅ 正常 | 「先摸清项目现状与上次中断点」「已恢复上下文…」+ 编号列表「1. XSJTATools.uplugin —」（`111ae17e.jsonl:8/24`、`session-…0143.messages.jsonl:41`） |
| 索引 sdkSessionId 小瑕疵 | ⚠️ 记录问题 | `agent-sessions.json` 的 `sdkSessionId` 末 6 位（`82e1a3`）与磁盘 SDK 文件（`4c5a87`）不符；不影响功能（前缀+内容已比对为同一会话），但 resume/定位可能踩坑 |

---

## 6. 复现条件 + 最小修建议

### 6a. 复现「最新会话里的失败」（Bash fork）

- 机型：本机 Windows 11 + Git bash（`C:\Program Files\Git`）。
- 触发：TAgent-Desktop GUI（dev 构建）在 **D--UnrealTagManager / 任意工作区** Work 模式下调 Bash 跑任意命令 → `Exit code 5` fork 报错；模型被迫改 Glob/Read/Grep。
- 与子代理**无关**：无论渠道/模式，Bash 都会犯；子代理问题需另起条件（见 6b）。

### 6b. 验证 haiku 修是否真生效（**用户须做**）

1. **rebuild + 重启** TAgent-Desktop（让 831c941 进运行进程；当前最新会话跑在 11:11 旧构建、未重启）。
2. Work 模式 + kscc-internal（glm-5.2）渠道，发一个**会触发委派**的任务（如「探索一下项目根目录结构，列主要模块」），诱导模型调 `Agent`(subagent_type=explorer)。
3. 判据：
   - 子代理卡出现后**有工具进度**（Glob/Grep/Read 行进）→ `completed`（绿），子代理 assistant `model:"glm-5.2"`（继承父）→ **修生效**。
   - 子代理卡出现后直接红字「失败」、无进度；主进程 `[kscc stderr]` 若是 **model/API 报错** → 修没进运行进程（rebuild 没成功/没重启）；若是 **`不是内部或外部命令`/`exit 1`** → 转根因 2（Windows 嵌套 spawn）。

### 6c. 最小修建议

| 修 | 范围 | 依据 |
|----|------|------|
| **Bash fork（主）** | GUI 主程序 Bash 工具的 spawn 在本机 Git bash 下 fork 失败 → 复用/下放 `kscc-windows-spawn.ts` 的 `node.exe` 直跑思路，或确保子进程环境 PATH 含 Node/Git 目录；dev 下补 PATH（release 已从注册表补，见 ROUND1 根因 2 注） | `111ae17e.jsonl:9/68`、`session-…0143.jsonl:9/68`；[[windows-git-bash-sandbox-fork]] |
| **haiku 修运行验证** | rebuild+重启后按 6b 实跑一轮 | 本轮无运行侧证据 |
| **AskUser answers 回灌** | 确认 Desktop 是否把点选写进 `updatedInput.answers`；若否 → 补 H 移植 | `111ae17e.jsonl:112` `answers:{}`；[[regress-h-askuser-canusetool-not-controlframe]] |
| **索引 sdkSessionId 对齐** | 写索引时 `sdkSessionId` 与 SDK JSONL 文件名 uuid 对齐 | `agent-sessions.json` vs 磁盘 `…4c5a87` |
| **不动** | UI 侧、落盘闸口、思考链 | 本轮均正向/无异常 |

---

## 7. 待证实（下轮）

- rebuild+重启后，kscc-internal + Work + 派 explorer：子代理 `model` 是 `glm-5.2`（修生效）还是仍 `haiku`（修没进进程）？收口 `completed` 还是 `failed`？
- 若仍 `failed`：抓 `[kscc stderr]` 定性——model/API 报错（根因 1 残留/未进进程）vs spawn `exit 1`（根因 2，Windows 嵌套 spawn）。
- AskUser：用户确认选项卡是否出现/是否点过；若出现且点过仍 `answers:{}` → 坐实 Desktop H 移植 answers 回灌未接。
- Bash fork 是否在 release 构建也复现（dev Electron 环境更易缺 PATH）；若是，把 Windows spawn 补丁下放到 Bash 工具层。
- 修 `agent-sessions.json` 的 `sdkSessionId` 登记一致性。

---

## 附：本轮方法 / 与前序 scout 的差异

- 前序 scout（本文档早先版本）结论大体对（无 Agent、Bash fork、haiku 修未验证），但 **§「面板落盘路径今日空白」是错的**——它查 `~/.tagent/projects`（非 dev），实际 dev 落 `~/.tagent-dev/projects/`（`session-store.ts:15`）。本轮补定位到 `session-1786070710143` + `agent-sessions.json` meta（`executionMode=work`/`modelId=glm-5.2`/`sdkSessionId=111ae17e`），把「111ae17e = GUI 会话 SDK 副本」接上。
- 本轮新增：`8626f1b5` 小写 explorer 基线（同 codepath 跑通）、回归窗口（`620ed2e`/`e495962`/`831c941`）、build-lag 推断、AskUser 空 answers 实证、`bbbde384` 大写 CLI agent 旁证（并指出其不走 haiku 钉死）。
- 本轮未改代码、未 commit。前序 scout 临时脚本（`_tmp-scan-failures.mjs`、`_tmp-parse-session.mjs`）可删。
