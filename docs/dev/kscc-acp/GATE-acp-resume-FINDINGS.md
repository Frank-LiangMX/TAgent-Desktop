# GATE · kscc ACP 握手 + resume + context usage · 前置验证 FINDINGS

> 角色：只读探测 / 落盘结论。**未改 TAgent 业务代码、未 commit。**  
> 探测环境：本机 Windows 11，2026-08-07（+08）。模型 glm-5.2。  
> 权威背景：[调研 §6-§7](../../plans/2026-08-07-kcwork-kscc-acp-research.md)、[00-MASTER](./00-MASTER.md)、[brief](./GATE-acp-resume-brief.md)

---

## 结论表（三门）

| # | 门 | 结论 | 一句话 |
|---|---|---|---|
| 1 | PATH `kscc` 支持 `--experimental-acp`？ | ❌ | PATH `@seasun/kscc` 1.1.28 三形态全无：`--experimental-acp`→`error: unknown option`(exit1)、`--acp`→同报错、`--help` 无 `acp` 子命令。 |
| 2 | ACP 模式下 `--resume <sid>` 仍可用？ | ❓ | kscc 根本进不了 ACP（门1❌），无法在 kscc 上验证；且 KCwork 自身「kscc」后端走 stream-json+`--resume`（claude-agent-sdk，非 ACP），ACP 与 resume 是并列两条后端路径，非同一会话共存。 |
| 3 | ACP 会话推 context usage？ | ❓ | kscc 无 ACP，不可在 kscc 上验；协议级 KCwork AcpAdapter 注册 `onContextUsage({used,size,cost})`（asar 实证）；本轮未驱动出 ACP 模型回合（捆绑 ksoc/opencode 传输为 HTTP/WebSocket 非 stdio，ACP-SDK 受 00-MASTER §3 本轮禁用），故无实证事件。 |

**净结论：当前 kscc 1.1.28 无 ACP 模式，调研 §8「把 `--bare --stream-json` 换 `--experimental-acp`」在现版本不可执行。**

---

## 版本对比表

| 产物 | 路径 | 版本 | ACP 支持 | 说明 |
|---|---|---|---|---|
| PATH kscc（**TAgent 实际 spawn 的**） | `C:\Users\loumi\AppData\Roaming\npm\kscc` → `node_modules\@seasun\kscc\kscc.exe` | **1.1.28** | ❌ 无 `--experimental-acp`/`--acp`/`acp` 子命令 | claude-code 家族（help 首行 `Usage: claude`）；`@seasun/kscc` 在公网 npm **404**（私有包，内网 registry `npmhub.ksyun.com`），无法 `npm view` 查最新版 |
| KCwork 捆绑「ksoc」 | `C:\Program Files\KCwork\resources\bundled-ksoc\ksoc-windows-x64\bin\ksoc.exe` | 1.0.4 | ✅ 但走 `opencode acp` **子命令**（非旗） | 实为 **opencode** 二开（help 全是 `opencode …`）；ACP 是 HTTP/端口服务（`server=http://127.0.0.1:4096`），**不是 kscc、不是 stdio JSON-RPC**；`TOKEN_KEY=KSCC_AUTH_TOKEN`，读同一网关 `http://120.92.138.34` |
| `ksgc`（调研所谓「kscc ACP」的真身后端） | 未安装（`where ksgc`→not found） | — | — | asar 注释：「金山云 KSGC CLI（基于 **Gemini CLI** 二开），使用 `ksgc --acp`」；注册表 `ksgc:{acpArgs:["--acp"]}`；本机未装，无法实测 |
| `claude` CLI（claude 家族 ACP 后端） | 未安装（`where claude`→not found） | — | — | asar `claude` 预设无 `acpArgs` → 回退 `DEFAULT_ACP_ARGS=["--experimental-acp"]`；本机未装 |

> 注：调研写 KCwork 在 `D:\Program Files\KCwork\`；本机实际在 `C:\Program Files\KCwork\`（含 `resources\bundled-ksoc\ksoc-windows-x64\bin\ksoc.exe`）+ `C:\Users\loumi\AppData\Roaming\kcwork\`。

---

## 证据（命令原文 + 关键输出，sk 打码）

### A. 旗面（门1）

```text
$ where kscc
C:\Users\loumi\AppData\Roaming\npm\kscc
C:\Users\loumi\AppData\Roaming\npm\kscc.cmd

$ kscc --version
1.1.28

$ kscc --experimental-acp -p "say hi in one word" --dangerously-skip-permissions
error: unknown option '--experimental-acp'        # EXIT 1

$ kscc --acp -p "say hi in one word" --dangerously-skip-permissions
error: unknown option '--acp'                     # EXIT 1
```

- `kscc --help` 全量 60+ 选项里**无** `--experimental-acp` / `--acp`；Commands（agents/auth/auto-mode/doctor/install/mcp/plugin/project/setup-token/ulareview/update）**无** `acp` 子命令。
- 控制对照：`kscc --experimental-foo-bar --help` 也 EXIT 0 → `--help` 短路、不校验未知旗；故 `--experimental-acp --help` 不可信，必须用 `-p` 短跑判 `unknown option`（已做 → ❌）。
- `@seasun/kscc` 在公网 npm 不存在（`npm view @seasun/kscc version` → 404），无法远程确认新版是否加 `--acp`。

### B. KCwork app.asar 实证：ACP 旗与后端注册表（修正调研 §2.2）

`C:\Program Files\KCwork\resources\app.asar`（只读 grep，窗口截取）：

```text
const DEFAULT_ACP_ARGS = ["--experimental-acp"];
// Use --acp instead of deprecated --experimental-acp
// KSGC 使用 --acp flag（旧名 --experimental-acp 已废弃）
const effectiveAcpArgs = acpArgs === void 0 ? ["--experimental-acp"] : acpArgs;

# 后端注册表 cliCommand 清单——【无 "kscc"】：
claude / opencode / ksoc / ksgc / codex / qwen / kimi / copilot / codebuddy /
goose / auggie / vibe-acp / snow / qodercli / kiro-cli / hermes / droid / agent

# 各后端 acpArgs（节选）：
ksgc:{id:"ksgc",...acpArgs:["--acp"]}                          # Gemini-CLI 二开，旗
ksoc:{id:"ksoc",cliCommand:"ksoc",acpArgs:["acp"],bundled:!0}  # opencode，子命令
claude:{id:"claude",cliCommand:"claude",...}                   # 无 acpArgs → 回退 --experimental-acp
kimi:{...acpArgs:["acp"]}                                      # 子命令
copilot:{...acpArgs:["--acp","--stdio"]}                       # 旗+stdio
```

- `presetAgentType` 枚举**只有 `"ksoc"`**（29 处）；`"kscc"` 仅作 `||"kscc"` 兜底默认标签，**非 ACP 后端 id**（`grep id:"kscc"` 0 命中）。
- `--resume` / `stream-json` 上下文来自 **`@anthropic-ai/claude-agent-sdk` 的 arg builder**（`["--output-format","stream-json","--verbose","--input-format","stream-json"]`、`--resume`、`--continue`、`--session-id`、`--fork-session`）——这是 claude/kscc 的 **非 ACP**（stream-json+resume）路径，与 TAgent kscc 核同源。
- 传输统计：`WebSocket`(1204) / `stdio`(655) / `/sse`(76) / `ws://`(17)——ACP 客户端走 WebSocket/SSE，**非纯 stdio**。

→ **修正调研 §2.2**：「kscc 渠道走 ACP、spawn `kscc --experimental-acp`」与现装 KCwork 不符——「kscc」是 stream-json+resume 后端；ACP 是另一组后端（claude/ksgc/ksoc…）；ACP 旗现名 `--acp`（`--experimental-acp` 已废弃）；捆绑 ACP 二进制是 opencode(ksoc)，不是 kscc。

### C. 捆绑 ksoc（opencode）ACP 启动实测（门2/3 可达性）

```text
$ "…\ksoc.exe" acp --help
opencode acp  start ACP (Agent Client Protocol) server
Options: --port[default 0] --hostname --mdns --cors --cwd --print-logs --log-level --pure
# 端口型 HTTP 服务，无 stdio 选项

# 起服务（stdin 需保持开启，否则 ~1s 自退）：
INFO service=acp server=http://127.0.0.1:4096 … acp 启动预热内置 mcp:发送 GET /mcp …
INFO service=mcp sk=已获取 skSource=优先 auth.json 的 ksyun.key,回退 env KSCC_AUTH_TOKEN
    baseUrl=http://120.92.138.34 …
INFO service=ksc-mcp-setup … ksc-local-mcp 配置已写入 opencode.jsonc
```

- `GET /`、`/acp`、`/sse` 等一律返回 **opencode Web UI 的 HTML**（SPA catch-all，200），**非** JSON-RPC 端点；`POST /acp` initialize 也回 HTML。
- ACP JSON-RPC 走 WebSocket/SSE 子路由（asar 实证），raw curl 打不到；干净 initialize 需 `@agentclientprotocol/sdk` 客户端——**本轮受 00-MASTER §3「验证前禁止引 ACP SDK」约束未引入**。
- 按 brief「超时/未知协议 → 记失败原因，不要死循环」：握手**未达成**，记录如上；**未发 prompt、未烧模型配额**。

### D. resume 共存（门2）

- kscc 无 ACP（门1），**无法在 kscc 上做 ACP+resume 实验**。
- 结构性证据：KCwork 把「kscc/claude 后端」放在 **stream-json + `--resume`**（claude-agent-sdk，非 ACP）路径，把 ACP 放在另一组后端——即「resume 长驻」与「ACP」在 KCwork 里是**按后端二选一**，不是同一会话共存。若硬把 kscc 塞进 ACP 路径（`type==="acp"&&backend==="kscc"`，调研所引），spawn `kscc --experimental-acp` 在 1.1.28 上直接 `unknown option` 失败。
- ksgc/ksoc 的 resume 语义各自不同（opencode 自管 session，非 claude `--resume`），且本机未装 ksgc / 未驱动 ksoc 模型回合，**不在 kscc 语义内可证**。

### E. context usage（门3）

- 协议级：KCwork AcpAdapter 注册 `onContextUsage(usage2)`（调研 §6.2；asar），data 期望 `{used, size, cost}`——ACP spec 的 context-usage 通知，**任何合规 ACP server 都可推**。
- 但本轮：① kscc 无 ACP，推不了；② 捆绑 ksoc/opencode 的 ACP 传输（HTTP/WS）本轮未驱动出模型回合（无 SDK、不发 prompt），**未捕获 `acp_context_usage` / `onContextUsage` 实证事件**。
- 即「ACP 能推 context usage」只在协议层成立，在本机 kscc 链路上**无任何实证**。

---

## 对主线建议

**结论：「需换 kscc 版本再验」+ 当前「维持 C（不动）」；不可在 kscc 1.1.28 上拍板 A。**

理由：

1. kscc 1.1.28 无 ACP（门1❌），调研 §8 第 1 步「`--bare --stream-json` 换 `--experimental-acp`」**当前不可执行**——旗不存在。
2. KCwork asar 表明 claude 家族 ACP 旗已更名 `--acp`（`--experimental-acp` 废弃）；`@seasun/kscc` 是私有包（公网 npm 404），无法确认新版是否加了 `--acp`。**若 `kscc install latest`（内网 updater）能拿到带 `--acp` 的版本，需重跑本 gate**（门2/3 才有实测对象）。
3. 即便拿到 `--acp`，要拿 context usage 仍需引 `@agentclientprotocol/sdk`（00-MASTER §3 验证前禁止）+ 自管/重建 resume（ACP 无状态）+ 一次性回归——代价与调研 §6.3 评估一致。
4. 备选「换后端」（spawn ksgc=Gemini-CLI fork 或捆绑 opencode/ksoc 走 ACP）是**换 CLI/换后端**，不是换旗——会动「免费国产模型（glm/kimi/mimo）经 claude 家族 kscc 网关」这条收益链，属另一场评估，不在本轮前置范围。

→ 拍板选项映射：**当前维持 C**；若用户坚持要 usage 精确，前置追加动作 = **「换含 `--acp` 的 kscc 版本后重跑门2/3」**（A 的真前置），或接受「换后端」另起评估。**不建议**在 1.1.28 上直接拍 A。

---

## 本轮不做（合规自检）

- ✅ 未改 `apps/`、`packages/`、产品配置、`.claude/settings.json`（`git diff --stat -- apps packages` 为空）。
- ✅ 未 commit / push（`git status` 仅原 `?? docs/dev/kscc-acp/` 未跟踪目录）。
- ✅ 未引 `@agentclientprotocol/sdk`（遵守 00-MASTER §3）。
- ✅ 未发 ACP prompt、未烧模型配额（仅 `initialize` 级探测，且未成功）。

### ⚠️ 副作用声明（需用户知悉）

为做 ACP 握手，本机起过捆绑 `ksoc.exe acp`。ksoc 启动会按其设计自动注入 `ksc-local-mcp`，**改写了两个用户配置文件**（均在 `C:\Users\loumi\.config\opencode\`，**非仓库内**）：

- `opencode.jsonc`（431 B，mtime 08-07 23:38）写入 `mcp.ksc-local-mcp`，含 `KSCC_AUTH_TOKEN: sk-lSkd4H<REDACTED>` + `BASE_URL: http://120.92.138.34`；
- `ksc-settings.json`（40 B）写入 `{"BASE_API":"http://120.92.138.34"}`。

此为 KCwork 自身每次启动都会重写的自动配置，非持久性污染；**未回滚**（回滚会被下次 KCwork 启动重写，且可能移除你依赖的 ksc-local-mcp 注入）。如需干净，可手动从 `opencode.jsonc` 删 `mcp.ksc-local-mcp` 段。临时探测日志留在 `%TEMP%\kscc-acp-probe\`，可删。

---

*建议更新调研 §7 勾选：前置验证已做，结论 = 「kscc 1.1.28 无 ACP 旗，需换含 `--acp` 版本再验门2/3」；并修正 §2.2「kscc 渠道走 ACP」→「kscc 为 stream-json+resume 后端，ACP 属 claude/ksgc/ksoc 等另一组后端，旗名 `--acp`」。*
