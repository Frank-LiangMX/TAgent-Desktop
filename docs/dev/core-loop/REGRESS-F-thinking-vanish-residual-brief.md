# REGRESS-F Brief — 思考块仍有时立刻消失（E/D 残留）

> 规格：`REGRESS-2026-08-07-RESIDUAL-SPEC.md` §F  
> 派工：本机 `kscc -p --dangerously-skip-permissions`  
> **本轮默认只读摸底**；若根因明确且与 E 补丁缺口一字对齐，可最小修 + vitest。勿大改。

## 背景

昨夜 REGRESS-E 已修：`_partial` 推断、`preserveAssistantThinking`、`tool_start` 只清 text、`commitStreamThinkingToLastAssistant`。  
用户今日：**有时思考块仍立刻消失**（非「settle 后折成思考了 Ns」）。

## 必答（带 path:line）

1. 当前工作树 E 补丁是否仍在？（对照 FINDINGS 文件列表逐文件核对关键函数）
2. 还有哪些路径会**删掉** thinking segment / 清空 `streamState.thinking` / 把 thinking 从 content 剥掉？
   - 重点：`resetStreamState` 全清调用点、`shouldClearStreamThinking`、同 uuid upsert、`turn_end`/`result`/`tool_start`/`message_*`
3. UI：`ThinkingFold` 是否仍有「`open=false` + body=null」瞬间卸 DOM 的路径？settle 定时器是否被别的 effect 抢清？
4. concise 模型：思考进 `work_stage.steps` 后折叠摘要是否让用户误以为「块消失」？（产品 vs bug 区分）
5. 若有 `~/.tagent/agent-sessions/*.jsonl` 最近会话，抽一轮含 thinking 的回合，看落盘 content 是否含 thinking。

## 假设（验证后写 FINDINGS）

- H1：某条事件仍全量 `resetStreamState`（漏网）
- H2：final upsert 无 thinking 且 `preserveAssistantThinking` 未命中（uuid/role/形态变了）
- H3：仅 UI：`isLive` 瞬间 false + settle 被跳过 / reduced 路径卸 body
- H4：思考被埋进 stage，leading fold 条件过严导致 0 条 `kind:'thinking'`

## 交付

写 `docs/dev/core-loop/REGRESS-F-FINDINGS.md`：根因 1–3 条 + 证据；是否需再修；若修则改动列表 + 测试命令。不 commit。
