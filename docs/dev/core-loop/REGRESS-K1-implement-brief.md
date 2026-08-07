读并严格执行 docs/dev/core-loop/REGRESS-K1-persist-thinking-SPEC.md。

任务：修「思考类正文流完即消 + 执行块无思考行」（K1）。

必改：

1) ProcessGroupView（full 默认路径）
- 过程组 `showBody=false`（idle 自动收起）时，**仍渲染所有 type==='thinking' 的 ThinkingActivityRow**（头栏可见、可点开）。
- 工具行 + ProcessTextRow 继续只在 showBody 内。
- 布局建议：toggle 头下方常驻 thinking 行，再 `{showBody && <body tools+texts>}`；避免思考进被卸的 body。
- 保留思考默认收起 + settle；不要改回 live 自动铺开全文。

2) concise-timeline-model
- idle 时 **禁止** `isTrivialThinking && !isLive → continue` 整段丢弃；改为仍推 stage step 或独立 ThinkingFold（至少「思考了片刻」可点开看全文）。
- 若中段思考只在 stage.steps：确保 idle 后展开 stage 能看到 thinking step；可选：stage summary 含思考次数或收起态露思考 step 头（SPEC 优选，有时间做）。

3) 单测覆盖上述行为；写 docs/dev/core-loop/REGRESS-K1-FIX-NOTES.md。

约束：不 commit / 不 push；不改 AskUser/K2/Bash；仓库根 F:\TAgent-Desktop。

返回：改了哪些文件 + 测试结果 + 手测要点。
