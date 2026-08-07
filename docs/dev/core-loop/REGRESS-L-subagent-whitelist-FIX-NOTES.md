# REGRESS-L FIX NOTES — 子代理入口白名单（不再个案加黑名单）

> 日期：2026-08-07  
> 用户：`tool` 又被标成「子代理」；要求不要「遇到一个加一个」。

## 策略

**默认拒绝，白名单放行**（不是 `!= local_bash`）：

| 门 | 规则 |
|----|------|
| `isSubagentRuntimeTaskType` | 仅 `local_agent` / `agent` / 安全的 `*_agent` |
| `reduceTaskEvent` 新建卡 | 必须 `canCreateSubagentTaskCard`；`local_bash` started 会摘掉误建卡 |
| `listSubagentEntryIds` | `taskCard` 仅当 `taskType` 为 agent；launcher 仅 Agent\|Task |
| `findSubagentTaskTool` | 同 id 的 Bash/Glob **返回 null** |

## 改动文件

- `subagent-ui-model.ts` + 单测
- `session-turn-model.ts` + `subagent-turn-group.test.ts`
- `Chat.tsx`：传入 `evt.taskType`

## 手测

Bash / Glob 失败不应再出「子代理」行；真 `Agent`/`Task` 仍出入口卡。
