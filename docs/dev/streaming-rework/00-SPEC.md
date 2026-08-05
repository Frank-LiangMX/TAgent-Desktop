# 流式链路重构规格

> 基线 commit：`25b557d`。本文件是本轮所有改动的唯一规格来源，子代理据此实现，不得自行扩大范围。

## 1. 目标

会话输出要「丝滑、完整」：

- 正文与思考都**逐 token 出现**，不是跑完一次性刷出来。
- 流式期间**增量渲染 Markdown**，不是先看原始文本、结束才排版。
- 一轮内不出现内容**闪空、跳变、被降级成一行灰字**。
- 滚动稳定：不强制回底、不因高度抖动被甩走。
- 文件 chip 状态稳定，不在流式中反复闪「文件不存在」。

## 2. 现状根因（三方对照结论）

对照 `F:\TAgent_General`（同源、稳定）与 `F:\Proma`（成熟双链路）后确认：**成熟模式本项目都有，问题出在 Desktop 自研时偏离了契约**。四个根因：

| # | 症状 | 根因 |
|---|------|------|
| R1 | KSCC 思考全量出现 | thinking delta 需要先有 DisplayItem 才能绑定；KSCC 不发空占位（只有 Pi 发），thinking 又先于正文到达 → 每个 delta 都被 `!bound` 丢弃 |
| R2 | 正文只显示一行随后被滚走；完成才出 Markdown | `buildTurnPresentation` 仅在整轮 idle 时才把尾部 text 拆进回答区；运行中它留在过程区，被渲染成 80 字截断灰字 |
| R3 | 整轮反复重挂载（疑） | KSCC partial 的 `uuid` 可能每条不同，`upsertStreamItem` 走 uuidMismatch 分支新建 key → turn key 变化 → 子树重挂、打字机失效 |
| R4 | 文件 chip 反复不存在 | 未注入 `basePaths`；裸名查找有扫描上限且**负结果被缓存**（主进程 60s / 渲染层 10s）；chip 只缓存正结果，每次重挂载都重查重闪 |

R1/R2/R3 同源：**流式内容被塞进了 `items` 数组，与消息共用生命周期和 key**。

## 3. 架构决定

### 3.1 流式状态与消息分离（对齐 General）

```
现状： items: DisplayItem[]   // 消息 + 流式占位混在一起，靠 uuid 绑定
目标： items: DisplayItem[]   // 只放已落盘消息 / taskCard
       streamState: { text, thinking }  // 会话级，独立于 items
```

约束：

- delta **只**累加进 `streamState`，永不创建/修改 `items` 元素。
- 段边界显式清空 `streamState`：`tool_start`、`turn_end`、新用户输入。
- 完整 assistant 消息到达时：先把消息推进 `items`，**同一批更新**里再清对应 `streamState`，禁止出现「已清流式、未挂消息」的空帧。
- 渲染 live 轮时，回答正文取 `streamState.text`，思考取 `streamState.thinking`；两者都不依赖 `uuid`。

这样 R1（无需绑定，不会丢）、R3（无 per-delta key，不重挂）自然消失。

### 3.2 尾部正文即回答（修 R2）

`buildTurnPresentation` 拆分规则改为：**尾部连续 text 一律进回答区，与是否 live 无关**；仅当其后仍有未闭合工具时才留在过程区。

### 3.3 文件路径解析（修 R4）

- 渲染层注入 `basePaths`（会话工作区目录 + 已知附加目录）。
- 主进程：**不缓存未命中**；命中才缓存。
- 裸名查找的扫描上限对本仓库规模要够用，两轮扫描不得共用同一计数器。
- `RESOLVE_FILE` 的递归扫描不得阻塞流式事件投递（主线程同步 `readdirSync` 与 `webContents.send` 同线程）。

## 4. 验收标准

功能性（必须有自动化测试覆盖）：

1. 给定一串 KSCC 形态的 `stream_thinking_delta`（无空占位、先于正文到达），思考文本逐条累积可见，无丢弃。
2. 给定 partial `uuid` **每条都不同**的 delta 序列，turn key 与 DisplayItem key 保持稳定。
3. 一轮含「thinking → tool → text」时，text 在 live 期间即出现在回答区，不被截断进过程区。
4. 完整 assistant 消息落盘的那一帧，回答区文本不为空（无闪空）。
5. `findFileByName` 在本仓库规模下能命中深层源文件；未命中不写缓存。

工程性：

- `bun run typecheck` 全绿。
- `npx vitest run` 全绿，且新增测试覆盖上述 1–5。
- 每个工作流单独 commit，信息说明「为什么」。

## 5. 工作流拆分

| 编号 | 范围 | 主要文件 | 依赖 |
|------|------|----------|------|
| W1 | 流式状态与消息分离 | `Chat.tsx`、`session-turn-model.ts`、`AssistantTurnView.tsx` | — |
| W2 | 尾部正文即回答 | `session-turn-model.ts` | 与 W1 同批 |
| W3 | 文件路径解析链 | `Chat.tsx`(provider)、`session-service.ts`、`file-search.ts`、`file-path-chip` | 独立，可并行 |
| W4 | 回归测试 | 新增测试文件 | W1/W2 之后 |

## 6. 不做

- 不引入 Streamdown 等新依赖修未闭合围栏——General/Proma 都没有，`react-markdown` 容错已足够。
- 不搬 General/Proma 的 EventBus、灵动岛、飞书桥等产品耦合模块。
- 不重写 Pi 适配器；Pi 路径当前行为正确，只需与新契约兼容。
