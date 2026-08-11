# No-Progress Guard 收口验收（CLOSURE AUDIT）

> 日期：2026-08-11  
> 验收人：本地 `kscc / glm-5.2` 只读摸底（未改代码、未 commit/push）  
> 验收对象：`NO-PROGRESS-GUARD-SPEC.md` 实现（见 `NO-PROGRESS-GUARD-FINDINGS.md`）相对**当前打包版**是否收口  
> 真源：SPEC §16 / FINDINGS §3-7 / 本机会话日志 / `D:\Program Files\TAgent`（11:01 构建）

---

## 0. 一句话结论

**未收口。** Guard 实现仍未 commit / 未 push / **未进 11:01 打包版**（asar 内零 Guard 标记，且 Guard 源码 11:54+ 才写出，晚于构建）；即便进包，默认 `shadow` 不改行为，`maxTurns=50` 仍是唯一兜底；而本机最近一轮"打包版报错"经日志核实**并非工具循环 / `error_max_turns`**（是一次旧会话 resume/重连失败 + 一次瞬时 429 TPM 限流恢复），Guard 对这两类都不起作用——Guard 的目标风险在包内既未被触发、也未被消除。

---

## 1. Guard 代码是否已 commit / push / 进当前打包版

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 工作区相对 `origin/main` | HEAD == `origin/main`，无未推送提交 | `git log origin/main..HEAD` 空；`git log @{u}..HEAD` 空 |
| Guard 实现是否入 git | **未跟踪 / 未 commit** | `git ls-files --error-unmatch …/no-progress-guard.ts` → `did not match any file(s) known to git`；`git log -- no-progress-guard.ts` 空 |
| 最近提交 `1df702b`（11:45）含什么 | **只含 SPEC/brief 文档，不含实现** | 该提交 38 文件含 `NO-PROGRESS-GUARD-SPEC.md` + `…-implement-brief.md`，无任何 `no-progress*.ts` |
| 工作区未提交改动 | 11 文件 +608/-17（即 FINDINGS §1 全部实现） | `git diff --stat HEAD` 列出 `no-progress.ts`/`claude-agent-adapter.ts`/`pi-agent-adapter.ts`/`session-service.ts`/`Chat.tsx`/… |
| 打包版构建时间 | **11:01**（`TAgent.exe` 等 11:01；目录 11:32 为安装写入） | `ls -la "/d/Program Files/TAgent"` |
| Guard 源码最早写出时间 | **11:54**（`no-progress.ts`）；guard 主体 12:06 | `stat -c %y` 各 Guard 文件 |
| 打包产物是否含 Guard | **不含**（零标记） | `grep -a -c "paused_no_progress\|TAGENT_NO_PROGRESS_GUARD_MODE\|no_progress" app.asar` → **0**；对照 `grep -a -c "maxTurns\|cliWorkerId\|TAgent"` → 142（提取有效） |

**判定**：构建（11:01）早于 Guard 实现（11:54+），且实现从未 commit；无论打包流程从 git 还是工作树取源，11:01 产物都不可能含 Guard。**当前用户在跑的安装包里没有 Guard 代码。**

---

## 2. 默认 mode / enforce 注入 / 是否仍撞 maxTurns=50

- 默认 mode = `shadow`（`NO_PROGRESS_GUARD_DEFAULT_MODE='shadow'`，`packages/shared/src/types/no-progress.ts:26`）。`shadow` 只 `observe` + 发诊断事件（`shadow:true`，UI 忽略），**不注入、不拦截、不暂停**（FINDINGS §4.1）。
- enforce 需 `TAGENT_NO_PROGRESS_GUARD_MODE=enforce`（`resolveNoProgressGuardMode` 读 env，非法/缺省回落 shadow）。打包版未注入该 env（且代码本就不在包内）。
- `maxTurns=50` 兜底**保留未动**（FINDINGS §16.7 / §3 表第 7 行）。

**判定**：即便 Guard 进包，默认 `shadow` 不会提前 pause，模型仍会跑到 `maxTurns=50` 才停（只是多一份 shadow 诊断日志）。**"默认 shadow 仍撞 maxTurns=50"这一已知风险成立**——只是当前包连 shadow 都没有，风险更甚。

---

## 3. 本机会话日志：最近 error_max_turns / 工具循环

打包版 GUI 落 `~/.tagent/`（**非** `~/.tagent-dev/`，后者是 dev 态）；SDK raw 落 `~/.claude/projects/<cwd>/`。`agent-sessions.json`（11:32 改）为会话真值表。

**今日（11:00 后）有活动的打包会话仅两条**：

| 会话 | 状态 | cwd | tool_use | is_error | terminal result subtype | error_max_turns | api_error | paused_no_progress |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `bddb5510`（11:31，今日活跃） | **idle** | D:\UnrealTagManager | 205 | 10 | **(none)** | **0** | 2（429 TPM，已 retry 恢复） | 0 |
| `28d4d411`（Aug-10 旧会话） | **error** | H:\j3-statics | 55 | 4 | **(none)** | **0** | 0 | 0 |

证据要点：
- **没有任何打包会话命中 `error_max_turns`**（两条均为 0）。全机日志里 `error_max_turns` 字面量只出现在 `F--TAgent-Desktop` 的 dev/audit 会话——那是"实现 Guard 时读 SPEC/FINDINGS 文档"留下的文本（在 `thinking`/`text`/`tool_result` 里），**不是真事件**。
- `bddb5510`（UnrealTagManager，即 FINDINGS §16.1 的已知循环复现项目）：205 次工具调用（64 Bash / 51 Edit / 43 Read / …），是正常"探索→改→验证"工作流，**非紧工具循环**；2 条 `api_error` 是 `429 TPM Ratelimit for glm-5.2`（retryAttempt 1/2，maxRetries 10），**已恢复**，会话以普通 assistant 文本结束、状态 idle；GUI `messages.jsonl` 中 **0 条 `session_error`**、**0 条"请求过于频繁"/"运行出错"**——限流被 SDK 静默重试吸收，未抬错误条。
- `28d4d411`（H--j3-statics）：`turnCount:2` 且两轮 `turnDurations` 均 `endedBy:'complete'`；SDK raw 文件 mtime 停在 **Aug-10 15:04**，但注册表 `status:error` + `updatedAt` 被刷到 **11:32 今日**，且无任何 `type:"result"` / `stoppedByUser` / system subtype。→ 这是**在旧会话上 resume/重连失败**（今日 11:32 触发，未产生新 SDK 落盘），表现为"运行出错"式崩溃，**不是工具循环**。

**判定**：用户"刚才又有一轮报错"经核实为 ① 旧会话 resume/重连失败（28d4d411，status:error，无终态 result）或 ② 瞬时 429 TPM 限流（bddb5510，已恢复）。**两者都不是 `error_max_turns` / 工具循环**，No-Progress Guard（针对工具循环/maxTurns）对这两类**不起作用**。

---

## 4. 对照 SPEC §16：代码层 vs 产品层

FINDINGS §3 已把 §16 七项在**代码层**判绿（纯判定器 27 例、双核 parity、终态归一化、classify 保护性停止等）。本验收补**产品层**判定：

| § | 验收项 | 代码层 | 产品层（打包版实测） |
| --- | --- | --- | --- |
| 1 | 已知序列不再跑到第 50 轮 | ✅（回放测试） | ❌ 未进包；且最近报错不是该路径 |
| 2 | 重复失败至少一次策略复盘 | ✅ | ❌ 未进包（shadow 也不注入） |
| 3 | 暂停不显示"运行出错"且可续跑 | ✅ | ❌ 未进包；classify 改动（`paused_no_progress`/`max_turns` 归保护性停止）同样未进包 |
| 4 | 正常多文件实现不被误杀 | ✅ | ❌ 未进包 |
| 5 | KSCC / Pi 判定一致 | ✅ | ❌ 未进包 |
| 6 | 触发可从结构化日志解释 | ✅ | ❌ 未进包 |
| 7 | maxTurns=50 仍作兜底 | ✅（未动） | ✅ 仍生效（且是当前唯一防线） |

**NP-0 实机矩阵、enforce 产品化、shadow 误报统计均未做**（FINDINGS §5）。

---

## 5. 缺口清单

1. **实现未 commit / 未 push / 未打包**——这是收口的首要阻断点；用户在跑的 11:01 包零 Guard。
2. **默认 `shadow` 不强制**——即便进包，也得 `TAGENT_NO_PROGRESS_GUARD_MODE=enforce` 才改行为；包内未注入。
3. **NP-0 SDK 长驻实机矩阵未跑**（FINDINGS §5/§6 风险 1-2：`PostToolBatch` 形状、`PreToolUse` 与 `canUseTool` 并存顺序、`interrupt()` 后续接能力均靠纸面推断）。
4. **"运行出错"误报根因不在 Guard 范畴**：最近两轮打包报错一是 resume/重连失败、一是 429 TPM 限流——Guard 不覆盖。收口"打包版报错"需另做：会话 resume/重连可靠性 + 限流退避的用户可见文案。

---

## 6. 建议下一步（最小收口路径，**本轮不实施**）

按 brief §5，仅当有明确安全最小补丁且不扩大范围才改代码；当前缺口是"未进包 + shadow 默认 + 最近报错非工具循环"，**改代码为时过早**，故本轮只产出本文档。建议：

1. **先收口"进包"**：`git commit` Guard 实现（11 文件）→ push → 重新打包，让用户至少跑上 `shadow`，先收集真实会话的 shadow 诊断日志（FINDINGS §6 风险 3、§15 Phase 0）。
2. **跑 NP-0 实机矩阵**（§22 Step 7 表，KSCC+Pi 双核 9 场景）：确认 `PostToolBatch additionalContext` 真到模型、`PreToolUse deny` 真拦住、`interrupt()` 后能接下条消息，再谈切 enforce。
3. **切 enforce 的两条路线任选其一**（不要在未跑矩阵前默认 enforce）：
   - 打包版注入 `TAGENT_NO_PROGRESS_GUARD_MODE=enforce`（electron-builder 注入 env / 主进程启动归一），或
   - 把 `NO_PROGRESS_GUARD_DEFAULT_MODE` 改 `enforce`（需 SPEC §20.1 放行条件：shadow 误报率达标 + NP-0 绿）。
4. **"运行出错"另线收口**：对 resume/重连失败（`28d4d411` 形态：turns 完成但 session error、无终态 result）做专门恢复/分类，对 429 TPM 在 SDK 重试耗尽后归 `rate_limited`（"请求过于频繁"）而非"运行出错"——这两条与 No-Progress Guard 正交，应单列。

---

## 7. 本次验收未做 / 限制

- 未改任何代码（brief 禁止 commit/push；无安全最小补丁命中）。
- 未实跑打包/重新构建验证 Guard 注入（需先 commit）。
- "刚才报错"的精确归属（resume 失败 vs 限流闪现）基于日志推断：`28d4d411` 文件 11:31 后无新写入、注册表 11:32 置 error + turns 均完成，指向 resume/重连失败；`bddb5510` 限流已恢复且 GUI 无错误条。如需坐实，需在打包版复现一次并抓 IPC。
