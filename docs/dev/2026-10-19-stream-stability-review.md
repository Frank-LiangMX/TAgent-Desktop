# 流式回答与思考稳定性审查

日期：2026-10-19。范围：当前工作树的 Pi/HTTP 主链路、兼容 SDK 增量链路、renderer 消息归并与时间线投影。

## 结论

现有代码存在可由确定性用例复现的消息身份丢失、显示内容重排和事件/绘制时序竞争。继续调整动画时长或增加“清空前保留一下”的条件，无法建立完整的稳定性保证。

本次已经修复三个具体问题。尚未录制用户实际故障会话的事件，也未完成整个转录状态模型的迁移，不能宣称所有闪烁已经根治。

## 实际数据流

- Pi：`pi-agent-adapter.ts` 收集 `message_update`，限频发送累计 partial；在消息/工具/回合边界 flush；`handlePiStreamPayload` 直接发送 IR，非 partial 才落盘。这条路径已经主要依赖消息快照，不能误认为它仍与原生 text/thinking delta 双重输出。
- SDK 兼容路径：`handleSdkStreamMessage` 用 `DeltaTracker` 派生增量，partial 的正文被置空；原生增量出现后抑制派生增量；持久化回传和 final 提供快照。
- renderer：`Chat.tsx` 分别维护 `items`、`streamState`、thinking rAF 缓冲、运行状态；消息进入 `applySdkMessageToItems`，再经过 `buildTurnPresentation`、concise 时间线以及显示 hook。

因此，同一种 UI 同时承担两种不同交接语义。Pi 本身提供完整消息，也仍会经过下述有损显示归并。

## 已复现并修复

### 1. 不同 UUID 仍可能覆盖上一条流式消息

位置：`apps/electron/src/renderer/components/chat/stream-item-model.ts`，`applySdkMessageToItems`。

旧逻辑先查 UUID；没找到后继续走“最后一条正在 streaming”替换。`A partial → B partial` 和 `A partial → B final` 都可能把 A 的位置、key 和内容让给 B。tool ID 兜底也可能跨 UUID 合并。随后 A 的 final 再到，会出现正文变化、重复或身份错位。

修复：有 UUID 的消息只按 UUID 更新或新增。仅无 UUID 的兼容消息保留旧的工具/位置兜底。

### 2. 显示归一化改变内容块顺序和身份

同文件的 `compactAssistantMessageForDisplay` 原来会收集所有 thinking，生成最多 900 字的摘要，并移到第一个 tool 之前。原始顺序例如：

```text
thinking A → text A → tool → thinking B → text B
```

会变成：

```text
text A → 合并的 thinking → tool → text B
```

而 `session-turn-model.ts` 用 `uuid + blockIndex` 形成文本/思考 key。改变数组位置也就改变组件身份。`__fullThinking` 又让完整思考回填到第一个 thinking，导致工具后的思考被搬到工具前。原来的摘要逻辑还会忽略不含特定关键词的短片段。

修复：正常消息完整保留块顺序、块数量和文本；旧版单块摘要副本可从 `__fullThinking` 恢复；流式思考提交也不再执行限长摘要。视图仍可以折叠，但折叠不改变转录内容。保留旧函数名是为了兼容已有历史加载入口。

### 3. 事件读取的是上一次 React render 的缓冲

位置：`Chat.tsx` 中原来的 `streamStateRef.current = streamState`，以及 delta、tool_start、result、turn_end 分支。

旧时序：

```text
delta → setState 排队
结束/工具事件 → 从 ref 读到旧文字 → 提交旧文字 → 清空
React 才渲染 → 最新 delta 已丢失
```

修复：提取 `useSessionStreamState`，按事件顺序同步更新摄取状态，然后发布 React 视图快照。边界读取不再依赖 React 是否已经绘制，render 也不再向事件状态写回旧值。没有使用 `flushSync` 或增加延时。

新增 React StrictMode 测试覆盖同批正文增量后立即结束、thinking flush 后立即结束、清空后同批进入下一阶段。

## 成熟实现中可借鉴的机制

### Codex：参考公开协议

官方 [App Server 文档](https://learn.chatgpt.com/docs/app-server) 定义 `item/started`、带同一 `itemId` 的增量和 `item/completed`；完成 item 是权威状态。reasoning summary 还有单独的分段边界。公开协议足以指导事件设计，不能据此推断桌面 UI 的全部内部实现。

### OpenCode：参考消息与 part 的生命周期

核对了固定版本 [processor.ts](https://github.com/anomalyco/opencode/blob/fc7e4cf93e660ad5ddabb0c48ecc99e934ebfe95/packages/opencode/src/session/processor.ts)。`reasoning-start` 和 `text-start` 建立 part，delta 定位 `sessionID/messageID/partID/field`，结束时更新原 part。该路径的 dev 文件后来被删除，因此引用可复核的提交，而非失效的分支链接。这不是对该项目无缺陷的承诺。

建议借鉴这两个项目的身份与生命周期约束。Cursor 本轮没有可核对的渲染源码，不把视觉观察当作其内部实现证据。

## 后续结构改造：统一转录状态，不继续堆叠显示补丁

### 第一阶段：将事件处理移出 Chat

把转录相关的 `sdk_message/stream_*_delta/result/turn_end` 收口到唯一 reducer/store，Chat 订阅投影。保留旧适配器作为输入转换层。items、流式正文、思考正文应属于同一个转录对象，不能先清临时态，再寻找正式消息补写。

当前补丁只是让临时缓冲的事件时序正确，并未完成这一迁移。

### 第二阶段：身份与版本在适配器边界确定

建议内部协议包含：

```ts
type TranscriptAddress = {
  sessionId: string
  runId: string
  messageId: string
  partId: string
}
// 事件操作：part.started / part.delta / part.snapshot / part.completed
// 运行边界：run.completed / run.failed / run.cancelled
// 由主进程分配 seq；快照带包含的最后一个 seq。
```

- 对 Pi，可先用固定 messageId + 原始 contentIndex 生成 partId，前提是适配器保证该消息的索引稳定。
- 不提供原生 ID 的上游，在 message_start 时分配一次；不要每次 fallback 都调用 Date.now()。
- 渲染 key 使用 partId，不使用“目前第几个过程块”或内容相似度。
- delta 只修改它定位的 part；不存在 part 时缓冲并请求同步，不追加到“最后一个 assistant”。
- 重放 seq 去重，发现缺口请求快照；旧 run 的事件不能复活已结束的新 run。
- final 只替换同身份对象，允许合法的权威修订；不能把“永远取更长字符串”当作正确性规则。

### 第三阶段：区分内容种类与展示状态

原始 reasoning、可读 reasoning summary、进度正文、最终回答必须有明确区别。上游没有 summary 时，显示可折叠的 reasoning；不要用截头截尾和关键词筛选伪装成摘要。没有明确 final phase 时，正文保持原位置，完成只更新状态；不要因为后面来了工具，就搬动已经显示的段落。

初次审查时 `useSmoothStream` 只有帧合并，没有渐进显示；调整它不能修复上游身份或内容归并错误。下述后续修改单独处理用户反馈的显示节奏问题。

### 第四阶段：历史与实时使用同一个模型

持久化完成快照及必要的运行身份。历史加载恢复相同的 message/part 身份；连接恢复采用带版本的快照加尾部事件。不要为 live 和 reload 分别编写补写逻辑。

## 应当保留的验收约束

1. 不同消息不能因“上一条还在 streaming”而合并。
2. 同一个 part 从首包、工具边界到结束，DOM key 与位置保持不变。
3. delta、快照、工具事件、完成事件可在一个 React batch 内连续到达，不能丢内容。
4. 已完成 part 不会被旧 partial 复活；明确的重试废弃事件可以撤销指定失败草稿，且不能伤及完成消息。
5. 原始 thinking/text 的顺序不因摘要、折叠、concise/full 模式而改变。
6. 正常完成后的实时转录与从历史加载的转录，在身份、顺序和内容上相等。
7. 用生产 reducer 重放事件，而非在测试里复制一份近似处理流程。现有 `thinking-live-persist-parity` 的辅助函数先 commit 后 upsert，Chat 实际先 upsert 后 commit，这是需要消除的测试偏差。
8. 接入一份脱敏的真实故障事件序列，再覆盖切会话、停止、重连、连续工具调用、重复快照和旧 run 迟到事件。不能仅凭静态截图验收。

## 本次验证

- 新增第一批 7 个用例在旧逻辑下全部失败，修复后通过；另补了实时/完成/历史投影和旧摘要副本兼容用例。
- 验证范围：消息归并、React 批处理、thinking 历史一致性、GLM 空壳、concise/full 流式视图、正文保留、增量重组与帧合并。
- 14 个相关测试文件、155 项测试通过；Electron TypeScript 检查通过；renderer 生产构建通过（Vite 提示大 chunk 和同模块静态/动态导入，不影响构建完成）；`git diff --check` 通过。
- 可复跑命令：

```powershell
bunx vitest run stream-identity.vitest.test.ts use-session-stream-state.test.tsx stream-item-model.vitest.test.ts thinking-live-persist-parity.vitest.test.ts regress-g-glm-empty-shell.vitest.test.ts AssistantTurnView.streaming.test.tsx ConciseTimelineView.streaming.test.tsx turn-presentation.vitest.test.ts regress-o-ui-swallow.vitest.test.ts narrative-preservation.vitest.test.ts regress-b-progress-live.vitest.test.ts concise-timeline-model.vitest.test.ts stream-delta-reassembly.test.ts useSmoothStream.test.tsx
bun run --filter='@tagent/electron' typecheck
bun run --filter='@tagent/electron' build:renderer
```

- 未调用真实模型、未运行打包后的 Electron 交互验收、未录制真实故障事件。本次结果确认这些代码缺陷已修复，不证明其他模型或网络时序均无问题。

## 后续：批量文字的显示节奏

用户反馈正文“一顿一顿，一下子出来一大段”。已确认 Pi partial 每 50ms 合并，而原 `useSmoothStream` 把最新快照在下一帧全部显示，网络批次的形状直接出现在屏幕上。

改为仅在显示层维护短缓冲：每批文字按经过时间匀速推进，积压增多时提高速度，正常帧率下目标约 650ms 追齐；不会在尾部逐渐减速。完成事件继续排完尾文，静态历史立即显示，权威内容替换和清空取消旧队列。支持完整 Unicode 字素与减少动态效果偏好。

concise 的进度/最终布局交接直接传入已显示前缀，不再绕一层 seed effect；展开思考直接展示已收到的全文，然后平滑新增内容。移除了思考/协作流里绕过显示缓冲直接回退到原文的路径，防止“先全显再缩回”。此显示缓冲不参与消息存储和持久化。

新增验收包括逐帧线性推进、50ms 连续批次、60/120Hz 节奏、最终尾文排空、布局重挂载的前缀保持、Unicode、StrictMode 和 reduced-motion。真实上游停发期间无法凭空补字；该修改平滑已收到的批次，并不保证网络断续完全不可见。

后续验证：8 个相关测试文件、81 项测试通过；Electron 与 UI 包类型检查通过。包含真实时间线组件和真实显示 hook，但测试中的 Markdown 渲染器使用了替身，因此仍需在实际 Electron 中评估长 Markdown 的绘制性能和主观流畅度。

## 后续：标点与回答排版

用户进一步反馈标点混乱。发现 `MessageResponse` 默认 remark 插件会对含中文的普通文本节点执行全角化和引号替换。真实渲染测试复现了以下问题：

- 中文段落中的 `C:\Work` 显示成 `C：\Work`，配置值与命令参数的直引号也被改成弯引号。
- 英文引文 `"Error: file not found!"` 的内部标点被中文化。
- 流式输出先收到开引号，随后收到闭引号时，之前已经显示的开引号被追溯替换。

新增 5 项回归用例在旧代码下失败。删除该插件后，显示保留模型原文标点；原有序号、代码、URL 与 Markdown 结构测试继续覆盖。中文写作规范由生成侧负责，渲染层不对技术文本做猜测性修正。

`buildOutputStylePrompt` 原先强制短答、有序编号、加粗标题独占首行及缩进细则，并示范用箭头连接结论。Chat/Work 模式提示还重复定义了这套规则。现改为自然短段落、按语义断句、按需列表和少量强调，保留代码及引用原文的精确标点；模式提示统一引用共享文风，不再覆盖成另一套模板。也取消了复杂回答先问“要不要展开”的默认要求。

这些提示词规则与用户反馈的符号堆叠相吻合，但没有用真实模型做改前/改后对照，不能把静态测试当作生成质量证明。Pi 的 system prompt 在会话创建时组装；应在加载新主进程代码后，用新会话验证文风。已有消息只改善显示保真，不会重新生成内容。

## 后续：终端悬浮入口与英文思考进入正文

删除 Chat 输入框上方的 `ComposerActivityIsland` 挂载及其活动订阅、粘滞缓存，去掉截图中的“1 终端”悬浮入口。Bash 执行、会话进程管理和时间线工具记录没有改动。

只读核对截图对应的本地消息记录，发现长篇英文推演已经以 `text` 落盘，相邻 assistant 消息则正确保存了 `thinking`。该会话使用 KSCC 网关的 Anthropic Messages 协议和 DeepSeek 模型。这证明问题发生在页面渲染之前，但没有原始 HTTP 响应，不能仅凭落盘文本断言是上游模型、网关还是客户端的唯一责任。

进一步检查已安装 pi-ai 0.82 的 `api/anthropic-messages.js` 与 `api/transform-messages.js`，确认两条请求转换路径会把历史思考转换成普通助手正文：同模型的 Anthropic thinking 缺少签名，以及跨模型回传 thinking。这会污染后续请求中的助手历史。

使用真实 pi-ai 和本地 HTTP SSE 服务器复现连续两轮调用：第一轮返回分离的 thinking/text/tool_use，第二轮检查真实 HTTP 请求。修复前无签名及跨模型案例在请求里出现额外的 `text` 思考段；签名完整、模型不变的案例正确保留 thinking。

修复在 HTTP 请求边界执行：

- Anthropic 协议下，DeepSeek provider 或 `deepseek-`/`deepseek/` 模型启用 pi-ai 的 `allowEmptySignature`，保留无签名 thinking 的类型。
- 跨模型 reasoning，以及不支持空签名的 Anthropic 模型的无签名 thinking，只从该次请求视图省略，避免 SDK 降级成正文。保留存储中的原消息。
- 保留同模型有效签名、正文、工具调用和结果关联；不依据英文、标点或 “Let me” 等词猜测内容类型。

验证包含 6 个两轮协议案例，覆盖网关、DeepSeek、完整签名、无签名、切换模型以及原始历史不被修改。连同适配器与时间线回归共 5 个文件、64 项测试通过；Pi-core 与 Electron 类型检查通过；Pi-core、主进程和 renderer 构建通过（renderer 仍有大 chunk 与静态/动态导入提示）；`git diff --check` 通过。

边界：这是已复现的上下文污染缺陷修复，尚未向用户真实网关发请求验证行为。不能保证网关支持空签名 replay，也不能证明截图中的无签名情况，因本地显示 IR 不保存签名。已污染的 `text` 历史不自动清洗；加载新主进程并使用新会话，才适合验证新输出是否恢复正常。如果干净会话仍有该现象，应采集脱敏的原始 SSE 类型与 SDK block 类型做比对，而非增加正文关键词过滤。

## 后续：三个 explorer 同时失败

截图对应本地会话的三个 task 均为 foreground explorer，分别要求梳理 C++、Agent、文档与配置，均返回 `子代理终态不是 stop（aborted）`。任务内容是较大范围的目录/文件调查，explorer 只有 Read/Glob/Grep。

该 assistant 的 Pi 时间戳为北京时间 15:53:26.869，三条工具结果在 15:54:36.208–210 落盘。派发消息生成到全部返回仅约 69.34 秒，因此按当前实现不符合每个子代理 120 秒超时的条件。外部取消正常会产生 stopped；本例为 failed。代码中另一条主动 abort 路径是：累计第 21 次 `tool_execution_start` 触发 20 次工具调用硬上限。计数针对调用而非模型轮次，批量调用也逐项累加，且失败的工具尝试也占次数。这是本例最有力的解释，但旧记录没有保存三个子代理各自的计数和原始终止原因，不能把推断冒充逐项完整日志证据。

已确认并复现的缺陷：工具上限/超时先写入原始原因，随后 message_end 的 aborted 错误和最终 stopReason 校验覆盖它；终止时的空 assistant 同时覆盖先前非空文字。因而既显示“无文本输出”，又看不到为何停止。

本次修复保留首个失败原因、最后非空阶段文字（明确标注未完成）、失败 summary、结构化 failureReason/stopReason，并将调用尝试次数和耗时写入可持久化的工具结果文本。原始错误放在正文之前，避免长结果截断时丢掉原因。空最终回复仍不算成功。

验证：19 项单元测试及 1 项真实 Pi + 本地 HTTP 测试通过。后者在一条模型消息中返回 21 个工具调用，确认只执行前 20 个，第 21 个触发 aborted，修复后保留工具上限原因及阶段文字；还验证成功任务、HTTP 400 和容量释放。Electron 类型检查、主进程构建、diff check 通过。未调用真实渠道或重跑用户项目分析。

本次未提高 20 次/120 秒限制。后续调度改进应让模型预知预算，接近上限时预留汇总机会，超限返回有明确未完成范围的阶段成果，并按任务复杂度设置预算；仅扩大上限不足以修复错误归因和强制中止丢结果的问题。
