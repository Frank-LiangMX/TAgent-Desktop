# 本机 Agent CLI 探测结论（2026-08-10）

> 范围：PATH 上 `kscc` / `grok` / `codex` / `mimo` 的 headless 调用与结构化输出形态。  
> 样本输出：同目录 `*-stdout.txt` / `*-stderr.txt`。

## 版本与路径

| CLI | 版本 | 路径 |
| --- | --- | --- |
| kscc | 1.1.28 | `%AppData%\Roaming\npm\kscc` |
| grok | 1.0.0 (3cd0d0cbce) | `~\.grok\bin\grok.exe` |
| codex | codex-cli 0.146.0 | `%AppData%\Roaming\npm\codex` |
| mimo | 0.1.9（exe 元数据 1.3.14） | `~\.mimocode\bin\mimo.exe` |

## Headless 入口（实测可用）

| CLI | 调用形态 | 推荐结构化输出 | 权限跳过 |
| --- | --- | --- | --- |
| **kscc** | `kscc -p --bare --model <m> ...` | `--output-format stream-json`（+可选 `--verbose`） | `-y` / `--dangerously-skip-permissions` |
| **grok** | `grok -p "<prompt>"` 或 `--prompt-file` | `--output-format streaming-json` 或 `json` | `--always-approve` |
| **codex** | `codex exec [prompt]`（stdin 亦可） | `--json`（JSONL 事件） | `-s read-only` 或 `--dangerously-bypass-approvals-and-sandbox` |
| **mimo** | `mimo run [message..]` | `--format json` | `--dangerously-skip-permissions` |

纯文本回包（无 JSON）：四者均可（kscc 默认 text、codex 默认文本、mimo default、grok 用 `json`/`streaming-json` 更合适）。

## 最小任务（仅回复固定串）

| CLI | 模式 | 结果 | 耗时（约） |
| --- | --- | --- | --- |
| kscc | text | `KSCC_OK` | 3.5s |
| kscc | stream-json | `result.result = KSCC_STREAM_OK` | 2.9s |
| grok | json | `{"text":"GROK_OK",...}` | 8.5s |
| grok | streaming-json | `type:text/thought/end` | 11s |
| codex | exec 文本 | `CODEX_OK` | 13s |
| codex | exec --json | `item.completed agent_message` | 13s |
| mimo | run default | `MIMO_OK` | 11s |
| mimo | run --format json | `type:text` + step_* | 10s |

## 带工具任务（列目录）— 事件形态

四者都能完成并回 `TOOL_DONE`（工具执行环境偶发失败不影响「协议可解析」结论）。

### kscc `stream-json`

顶层 type：`system` / `assistant` / `user` / `result`

- 工具：`assistant.message.content[]` 里 `type:"tool_use"`（name/input/id）
- 结果：`user.message.content[]` 里 `type:"tool_result"`
- 终态：`type:"result"` + `result` 字符串 + usage/cost

→ 与现有 `kscc-ndjson-parser` / Claude Agent SDK 族一致（Anthropic 消息块）。

### grok `streaming-json`

顶层 type：`available_commands` / `thought` / `text` / `tool_call` / `tool_call_update` / `usage` / `end`

- 工具开始：`tool_call`（toolCallId, toolName, rawInput, status）
- 工具更新：`tool_call_update`（status completed, rawOutput）
- 正文：`text.data` 分片；思考：`thought.data` 分片
- 终态：`end` + usage/cost

→ **不是**标准 ACP `session/update` 包一层，而是 Grok 自有 NDJSON；help 写 “ACP session updates” 与实测字段不完全同形。

### codex `exec --json`

顶层 type：`thread.started` / `turn.started` / `item.started` / `item.completed` / `turn.completed`

- 消息：`item.completed` + `item.type:"agent_message"` + `text`
- 命令：`item.type:"command_execution"` + `command` / `aggregated_output` / `status`
- 终态：`turn.completed` + usage

→ Codex 自有 item 协议。

### mimo `run --format json`

顶层 type：`step_start` / `step_finish` / `text` / `tool_use`

- 工具：单条 `tool_use`，`part.state.status` 已是 `completed` 时同时带 input+output（非 start/end 两段）
- 正文：`text` + `part.text`
- 终态：`step_finish` reason `stop` + tokens/cost

→ Mimo/OpenCode 风格 part 协议。另：`mimo acp` 子命令存在（真 ACP server），与 `run --format json` 是另一条路。

## 对 TAgent Adapter 的直接含义

| CLI | Invoke 要点 | Observer 映射到 ChildRunIR |
| --- | --- | --- |
| kscc | `-p --bare -y --model` + `stream-json` | tool_use/tool_result/text → tool_start/end/text_delta；result → run_finished |
| grok | `-p`/`--prompt-file` + `--always-approve` + `streaming-json` | thought/text → delta；tool_call/update → tool_*；end → finished |
| codex | `exec --json -C cwd` + sandbox 策略 | agent_message → text；command_execution → tool_*；turn.completed → finished |
| mimo | `run --format json --dangerously-skip-permissions` | tool_use(completed) → tool_start+tool_end；text → text；step_finish stop → finished |

**共同结论：**

1. **四者都可 headless 调用**，无需交互 TUI。  
2. **协议四套互不兼容**，但都是 **NDJSON 一行一事件**，适合统一 Host 按行喂 Observer。  
3. **不存在**「一个万能 parser」；需要 4 个薄 adapter → 同一 ChildRunIR。  
4. 纯文本模式可作 L0 兜底，但本机四者都已有 **L2 级 JSONL**，没必要默认 L0。  
5. `mimo acp` 可作为后期 L3 实验；kscc 本机 1.1.28 **无** `--experimental-acp`（与既有 GATE 一致）。

## 建议默认 spawn 模板（TAgent）

```bash
# kscc
kscc -p --bare --model <model> --dangerously-skip-permissions --output-format stream-json --verbose "<prompt>"

# grok
grok -p "<prompt>" --always-approve --output-format streaming-json [--model <model>]

# codex
codex exec --skip-git-repo-check --ephemeral -s read-only --json -C <cwd> "<prompt>"

# mimo
mimo run --dangerously-skip-permissions --format json -m <provider/model> --dir <cwd> "<prompt>"
```

长 prompt 优先 `--prompt-file`（grok 原生支持；其余写临时文件再 argv/stdin）。
