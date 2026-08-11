# FINDINGS：附件已发送但 Agent 未收到 — 根因 + 补丁

> 配套 brief：`docs/dev/attachments/SEND-ATTACHMENT-MISS-brief.md`
> 排查路径：Composer → Chat.sendQueued → IPC → session-service → kscc/Pi adapter
> 仓库：`F:/TAgent-Desktop`　日期：2026-08-11

## 0. 结论（TL;DR）

附件“界面像发出、Agent 没收到”有**两条独立断点**，分别落在不同层：

- **Bug B（根因，影响所有发送，含空闲态）**：`session-service.buildQueryOptions` 构造 adapter 查询时只透传 `prompt` 文本，**从不读 `input.attachments`**；adapter 契约（`AgentQueryInput`/`KsccQueryOptions`/`PiQueryOptions`/`SDKUserMessageInput`）也无附件字段，`claude-agent-adapter` / `pi-agent-adapter` 只喂纯文本。附件仅被写进面板 JSONL（`session-service.ts:1209/1224/1232`）并推 renderer → **UI 显示已发送**，但模型查询里根本没有附件 → **核侧从未收到**。
- **Bug A（回归，仅“运行中发送”路径，由队列引导改动 `53dd1b0` 引入）**：`Chat.tsx` 运行中入队只放 `{ text, selection }`，丢 `pendingAttachments` 且不清空 → 预览残留“像发出”，但队列项不带附件，drain / 立即发送时 `sendQueued(item)` 无附件可传。

**本次交付**：
- 我修了 **Bug A**（renderer 层，`Chat.tsx` 5 处，与 Bug B 主路径工作不冲突）。
- **Bug B（主路径）正由另一个并发 agent 实时实现**（多模态方案：图片打成 Anthropic image content block + prompt 末尾附绝对路径清单）。我**未触碰**它的文件，避免冲突；它在 `Chat.tsx` 之外，与我的 Bug A 修复**正交且可叠加**（队列路径把附件透传到主进程 → 它的主路径投递）。
- 残留缺口（steer / MoA seat / resume / 队列 UI 展示 / blob 回收）见 §5。

---

## 1. 断点证据

### Bug B — 主路径：附件落盘但从未进 agent 查询

| 层 | 文件:行 | 证据 |
|---|---|---|
| 落盘+推 UI | `session-service.ts:1209` / `:1224`（kscc）、`:1232`（Pi） | `userMsg` / `userIR` 上挂 `attachments: input.attachments` → 写面板 JSONL + `sendPayload` 推 renderer → **UI 显示已发送** |
| 查询构造（断点） | `session-service.ts` `buildQueryOptions`（原 1673–1918） | kscc `opts.prompt = input.prompt`（原 :1766）、Pi `opts.prompt = input.prompt`（原 :1885），**全函数不引用 `input.attachments`** |
| 适配器契约 | `packages/shared/src/types/agent-provider.ts` `AgentQueryInput`（原 27-38）/ `SDKUserMessageInput`（原 12-19） | 仅 `prompt: string` / `message.content: string`，**无 attachments 字段** |
| kscc SDK 调用 | `claude-agent-adapter.ts:147`（原 `content: input.prompt`） | 首条 user message `content` 为纯文本字符串，无 image block |
| Pi SDK 调用 | `pi-agent-adapter.ts:769`（`agent.prompt(prompt)`）、`:1014-1021`（enqueue 取 `content` 字符串） | 纯文本，无多模态 |
| 对照组（MoA） | `session-service.ts:1492` / `:1631` 转发 `attachments`，但 `run-moa-turn.ts:217/257`、`run-moa-discussion.ts:531/631` 只喂 `ctx.prompt` 文本；`moa-orchestrator.ts:101-103/187-191` seat runner `{ messages:[{role:'user', content: args.prompt}] }` | **MoA 也只落盘 + 推 UI，seat 同样收不到附件**——不是正确参照 |

**为什么“界面像发出”**：`session-service.ts:1209/1232` 把 `attachments` 挂进落盘的 user IR，`:1224/1240` `sendPayload` 推 renderer，渲染层据此画附件 chip → 看起来已发。
**为什么“Agent 没收到”**：真正进模型的 `opts.prompt` / `userMessage.content` 只有 `input.prompt` 文本，`input.attachments` 在 `buildQueryOptions` 边界被丢弃。

### Bug A — 队列引导回归（commit `53dd1b0`，“运行中发送”路径）

| 文件:行 | 证据 |
|---|---|
| `Chat.tsx` `messageQueue` 项类型（原 406-413） | 无 `attachments` 字段 |
| `Chat.tsx:1986`（原）`send()` 运行中分支 | `setMessageQueue((q)=>[...q,{text,selection}])` 丢 `pendingAttachments`，且**不** `setPendingAttachments([])` → 预览残留（“像发出”） |
| `Chat.tsx:2102` drain / `:2135` `sendQueueItemNow` | `await sendQueued(item)`，`item` 无 attachments → `sendQueued` 内 `if (attachments?.length)` 跳过 `saveAttachment`，`sendMessage` 无 attachments |
| `Chat.tsx:2151-2153` `steerQueueItem` | `window.electronAPI.steerAgent(sessionId, item.text)` 仅文本 |
| steer 全链路无附件槽 | `preload/index.ts:86` `steerAgent(sessionId, message)` → `session-service.ts:523-551` `STEER_AGENT` → `enqueuePendingSteer(sessionId, text)`（:217-221 存 `string[]`）→ `flushPendingSteer`（:285-303）`handleSend({sessionId,prompt,channelId,model,workspaceId})` **无 attachments** |

`53dd1b0` 新增 `sendQueueItemNow` / `steerQueueItem` 与队列自动消费重排，但未把 `pendingAttachments` 提进队列项（新代码遗漏，非删除既有透传）。

### 权限不挡（确认 Read 可达附件目录）

`packages/shared/src/constants/permission-rules.ts:570-573`：`SAFE_TOOLS` 含 `Read`，**只读工具对工作区外读取也放行**。附件存于 `~/.tagent[-dev]/attachments/{sessionId}/{uuid}.{ext}`（`attachment-service.ts:14/70`，`localPath` 为相对路径），agent 用 Read 读绝对路径不受 cwd/权限模式限制。

---

## 2. 根因

附件链路只建到**“持久化 + UI 展示”**（`saveAttachment` → JSONL `attachments` 字段 → renderer chip），**“投递给模型”这一段从未接线**：

- 主路径 `buildQueryOptions` 只取 `input.prompt`，`input.attachments` 形同未读；
- adapter 契约没有携带附件的形状，`query()` / `sendQueuedMessage()` 只构造纯文本 user message；
- 即便 MoA 转发了 `attachments`，seat runner 也只接受 `prompt: string`。

→ “落盘成功”被误当成“发送成功”。UI 与模型可见性是两条独立通道，只接通了前者。

`53dd1b0`（队列引导）在 renderer 侧又加了一道丢字段（Bug A），使“运行中发送”连主进程都到不了，但**根因是 Bug B**（空闲态也丢）。

---

## 3. 本次应用补丁（Bug A，renderer 层，`Chat.tsx`）

只改 `apps/electron/src/renderer/components/chat/Chat.tsx`（并发 Bug B 工作未触碰此文件，零冲突）。队列项带上附件快照，drain / 立即发送复用既有 `sendQueued`（其签名 `attachments?` 已存在，`Chat.tsx:1820`），自动走 `saveAttachment` → `sendMessage({attachments})` → 主进程（Bug B 工作）投递。

| # | 位置（改后行） | 改动 |
|---|---|---|
| 1 | `Chat.tsx:412` | `messageQueue` 项类型加 `attachments?: Array<{id,filename,mediaType,size,previewUrl?,data}>` |
| 2 | `Chat.tsx:1995` | `send()` 运行中入队：`...(pendingAttachments.length ? { attachments: pendingAttachments } : {})` + `setPendingAttachments([])` |
| 3 | `Chat.tsx:2048` | `sendConsult()` 运行中入队：同上 |
| 4 | `Chat.tsx:2100` | `sendDiscussion()` 运行中入队：同上 |
| 5 | `Chat.tsx:2212` | `editQueueItem()`：`if (item.attachments?.length) setPendingAttachments(item.attachments)` 还原附件到输入框 |

要点：
- 入队即 `setPendingAttachments([])` → 清空输入框附件（消除“预览残留像发出”）；`previewUrl` 不在入队时 revoke，由 drain 时 `sendQueued`（`:1866-1868`）统一 revoke，避免双 revoke。
- drain（`:2102`）/ `sendQueueItemNow`（`:2135`）无需改动：`sendQueued(item)` 现在能从 `item.attachments` 拿到附件。
- 空闲态直发路径（`:1995` 原逻辑）本就透传 `pendingAttachments`，未动。

---

## 4. 并发工作说明（Bug B 主路径，另一 agent 实时实现）

排查中发现工作树在秒级变动（`session-service.ts` enqueue 段在我两次读取间从 `buildEnqueueUserContent` 改为 `attachImageBlocksToText`；`.procs.txt` 显示本机同时跑大量 Cursor/codex/ChatGPT/Proma/kscc/electron 进程）。另一个 agent 正在实现 Bug B，采用**多模态方案**（比“最小 prompt 注入”更完整），已接近完成：

- 新增 `apps/electron/src/main/lib/agent/build-user-content-with-attachments.ts`（+ `.test.ts`）：
  - `appendAttachmentPathsToPrompt(prompt, attachments)` —— prompt 末尾附绝对路径清单（`getAttachmentAbsolutePath` 解析）
  - `attachImageBlocksToText(text, attachments)` —— 文本已含路径时只补 image block，避免双重 `[用户附件]`
  - `buildSdkUserContent` / `extractTextFromUserContent`（崩溃恢复取纯文本）
- `attachment-service.ts`：加 `getAttachmentAbsolutePath`（export `resolveAttachmentPath`）
- `packages/shared/src/types/agent-provider.ts`：`SDKUserMessageInput.content` 扩成 `string | Array<text|image block>`；`AgentQueryInput` 加 `attachments?`
- `session-service.ts`：`handleSend` 注入路径（当前 ~:1292），enqueue 用 `attachImageBlocksToText`（当前 ~:1383）
- `claude-agent-adapter.ts`：首轮 `attachImageBlocksToText(input.prompt, input.attachments)`（当前 :147）
- `session-runtime.ts`：已改（疑似 `extractTextFromUserContent` 用于 `lastInFlightPrompt`）

评估：**自洽且基本正确**（解决了双附录问题：先 `appendAttachmentPathsToPrompt` 再 `attachImageBlocksToText` 只补图块；图片走 Anthropic image block，文本/非图走路径让 Read 读）。**我只读未改这些文件**，避免与它的活改动冲突。`tsc --noEmit`（apps/electron）当前仅 3 个错，全在 `claude-agent-adapter.ts`（`NoProgressGuard`/`buildNoProgressEventFromDecision` 找不到——其编辑中途的瞬时 import 断裂，非我引入，且会随其保存修复）。

**与我的 Bug A 修复正交且可叠加**：队列路径把 `attachments` 透传到主进程 IPC（`sendMessage`），主路径（并发工作）接收 `input.attachments` 后投递。两条路径拼合后：空闲发送、运行中排队发送均能送达模型。

---

## 5. 残留缺口（未修，标注供后续）

1. **steer 路径无附件槽**（跨层，非最小）：`Chat.tsx:2151` `steerQueueItem` → `preload/index.ts:86` `steerAgent(sessionId, text)` → `session-service.ts:523-551/217-221/285-303`。要让引导带附件，需扩 `steerAgent` 签名 + `enqueuePendingSteer` 存 attachments + `flushPendingSteer` 透传 `handleSend`。**优先级低**（引导是高级动作，且附件引导语义本身模糊）。
2. **MoA seat 仍只见文本**：`run-moa-turn.ts` / `run-moa-discussion.ts` 只把 `attachments` 落盘，seat runner（`moa-orchestrator.ts:67-80` `MoASeatRunArgs`）无附件字段，prompt 构造不引用附件。会诊/圆桌带附件时模型侧仍收不到（需另接 `MoASeatRunArgs` 多模态或路径注入）。
3. **resume 丢附件上下文**：kscc resume 读 JSONL，落盘 user message `content` 为原文（无路径附录、无 image block），`attachments` 是自定义 sibling 字段 SDK 不识别 → 续聊/resume 后附件上下文丢失。需在落盘 content 里同样带上路径/image（落盘与查询用同一 `buildSdkUserContent` 输出可解决）。
4. **队列 UI 不展示附件**：`MessageQueue.tsx` 只渲染文本，队列项带附件时用户看不到附件 chip（功能性不影响投递，UX）。
5. **blob URL 轻微泄漏**：`removeQueueItem` / `clearQueue` 删队列项时不 revoke `previewUrl`（仅 drain 路径 revoke）。边缘场景（带附件入队后删除），预览 blob 不回收。可在 remove/clear 里补 revoke。
6. **preload `SendMessageInput` 类型过窄**（`preload/index.ts:51-71` 缺 `attachments`/`mentionRoleIds`/`executionMode`，被 `as any` 掩盖）：运行期不丢字段（IPC 透传整对象），仅类型安全洞。建议补齐字段声明去 `as any`。

---

## 6. 验证

### 类型检查（本次改动）

```
cd apps/electron && node node_modules/typescript/bin/tsc --noEmit
```
结果（当前工作树，含并发 in-flight 改动）：仅 3 错，**全在 `claude-agent-adapter.ts`**（并发 agent 瞬时 import 断裂）；**`Chat.tsx` 0 错**——本次 5 处改动编译干净。
（基线预存错见 memory `electron-tsc-baseline-errors`；本次只追 `Chat.tsx` 自身报错。）

### 手动验收（建议）

**A. 空闲态发文本附件**（Bug B 主路径 + 本次无影响）
1. 新会话，输入框拖入一个 `.txt` 文件，输入“总结附件”，发送（空闲）。
2. 预期：输入框附件清空；Agent 回复中**引用/读取了附件内容**（确认主路径投递，依赖并发 Bug B 工作完成）。

**B. 运行中排队发附件**（本次 Bug A 修复点）
1. 发一条长任务让 Agent 跑着（running=true）。
2. 输入框拖入 `.txt`/图片，输入“再看这个”，发送 → **应入队**（MessageQueue 出现该项）。
3. 预期：**输入框附件立即清空**（不再残留“像发出”）；等本轮结束 drain 后，Agent 在下一轮**读取/引用了该附件**。
4. 反证（改前）：入队后附件预览残留、drain 后 Agent 对附件毫无反应。

**C. 队列“立即发送”带附件**：B 入队后点该项「立即发送」→ 打断当前轮并以该条开新一轮 → Agent 读取附件。

**D. 队列“编辑”带附件**：B 入队后点「编辑」→ 附件应**还原到输入框**（preview 重新可见），改完再发。

**E. 引导带附件**（残留缺口 1）：B 入队后点「引导」→ 预期仍**丢附件**（已知未修，steer 无附件槽）。

### 单测建议（标出，未补）

- `Chat.tsx` 为组件，建议对 `send()` 运行中入队分支补渲染测试（mock `running`、`pendingAttachments`、`setMessageQueue`/`setPendingAttachments`），断言队列项含 `attachments` 且 `pendingAttachments` 被清空。
- 复用并发 agent 已建的 `build-user-content-with-attachments.test.ts` 覆盖主路径拼装（路径附录 / image block / 双附录防护）。

---

## 7. 改动文件清单

本次（我）：
- `apps/electron/src/renderer/components/chat/Chat.tsx`（Bug A，5 处：队列项类型 + 3 入队 + editQueueItem）

并发（另一 agent，in-flight，**我未改**，仅记录）：
- `apps/electron/src/main/lib/agent/build-user-content-with-attachments.ts`（+ `.test.ts`）
- `apps/electron/src/main/lib/attachment-service.ts`
- `apps/electron/src/main/lib/ipc/session-service.ts`
- `apps/electron/src/main/lib/adapters/claude/claude-agent-adapter.ts`
- `apps/electron/src/main/lib/agent/runtime/session-runtime.ts`
- `packages/shared/src/types/agent-provider.ts`
