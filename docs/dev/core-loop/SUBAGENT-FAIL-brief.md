# 摸底 Brief — 子代理总是「失败」

> 用户截图：concise 时间线「探索了 2 个文件」下一条 Bash/List 类步骤标 **子代理** + 红字 **失败**（描述：List project root, handoffs, and docs directories）。  
> 派工：本机 `kscc -p --dangerously-skip-permissions`  
> **本轮只读摸底**，写 FINDINGS；不 commit。

## 必答（path:line）

1. UI「失败」从哪来？`Task`/`Agent` tool_result error？exit code？超时？解析不到结果？concise `StageStepRow` 如何判失败？
2. Chat 下 SubAgent 是否应硬拦？用户若在 Work 仍失败：Task 工具实际走哪条（kscc agents / Pi subagent）？
3. 抽样 `~/.tagent/agent-sessions/*.jsonl` 最近含 Task/子代理 的回合：tool_use input、tool_result content、is_error。
4. 常见真因候选（验证后写）：
   - Chat 模式误派 Task → 硬拦当失败
   - agents 未注册 / prompt 空
   - cwd / 权限
   - tool_result 形状 UI 误判失败（结果其实成功）
   - 子代理进程立刻退出
5. 与 AskUserQuestion（H）是否相关？子代理路径是否 auto-deny 交互？

## 交付

`docs/dev/core-loop/SUBAGENT-FAIL-FINDINGS.md`：根因 1–3 条 + 复现条件 + 最小修建议。stdout 中文结论。
