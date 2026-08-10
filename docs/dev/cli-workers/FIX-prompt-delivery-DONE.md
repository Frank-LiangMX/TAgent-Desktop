# DONE · kscc 工人 prompt 投递（Windows 不拆词）

> 落地 `FIX-prompt-delivery-brief.md`。未 git commit。

## 根因复述

外渠 Pi `task` → `runKsccWorker`，`planSpawnCommand` 对 bare `kscc` 走 `cmd.exe /c kscc ... <prompt>`，
cmd 对 argv 重分词，prompt 被拆坏（短句 `Reply with exactly: PING_OK` 经 cmd 后 kscc 只看到 `Reply`），
kscc 当作无任务 → 回开场白「请告诉我你需要做什么」，`tool_result` 三次都拿到寒暄。

## 改动文件

| 文件 | 改动 |
| --- | --- |
| `apps/electron/src/main/lib/agent/cli-workers/run-kscc-worker.ts` | 重写 spawn 规划 + prompt 投递 + 寒暄软失败 + 日志 |
| `apps/electron/src/main/lib/agent/cli-workers/resolve-bin-on-path.ts` | **新增**：`where.exe` 把 bare 名解析成绝对路径（.cmd 优先 / .exe 次 / 兜底 null） |
| `apps/electron/src/main/lib/agent/cli-workers/run-kscc-worker.test.ts` | 更新：mock resolve+plan，断言非 cmd.exe / cmd 兜底走 stdin / 长 prompt stdin / 寒暄 ok:false |
| `apps/electron/src/main/lib/agent/cli-workers/resolve-bin-on-path.test.ts` | **新增**：`.cmd` 优先 / `.exe` 次 / 仅 shim → null / where 抛错 → null / 路径输入 |

## 实现要点（对照 brief）

### 1. Windows 禁 `cmd.exe /c` 传 prompt

`planSpawnCommand(bin, flagsArgs)` 返回 `{command, args, via, promptSafeInArgv}`：

- 非 Windows：`spawn(bin, args)`，prompt 作 argv 末位安全（`via=unix`）。
- Windows bare 名 → `resolveBinOnPath(bin)` 解析绝对路径（新函数，`where.exe`，优先 `.cmd`）。
- Windows `.cmd` → `planKsccWindowsSpawn(absCmd, flags)` 直连 `node.exe + cli-wrapper.js`（argv 不分词，
  prompt 作 argv 末位安全，`via=node`）；无 cli-wrapper → `cmd.exe /c <abs .cmd> <flags>`，但
  `promptSafeInArgv=false`（prompt 必须走 stdin，`via=cmd`）。
- Windows `.exe`（独立分发，如本机 `kscc.exe`）→ 直接 `spawn(.exe, args)`（Node→OS 不经 shell，argv 安全，
  `via=exe`）。
- bare 名解析失败 → `cmd.exe /c <bare> <flags>`，`promptSafeInArgv=false`，prompt 走 stdin。

### 2. prompt 投递（双保险 → 实测 stdin 为可靠主路径）

- `forceStdin = prompt.length > 4000 || prompt.includes('\n')` → 一律 stdin。
- 否则 `promptSafeInArgv=true`（node/exe/unix）→ prompt 作 argv 末位。
- 否则 `promptSafeInArgv=false`（cmd 兜底）→ **强制 stdin**（cmd 只见无空格的 flag，不再重分词）。
- stdin 投递：`stdio:['pipe','pipe','pipe']` → `child.stdin.write(prompt); child.stdin.end()`；
  argv 不再带 prompt。已实测 kscc `-p` 无位置 prompt 时从 stdin 读 text（`--input-format text` 默认）。

> **关于「写临时文件」的偏离说明**：brief 第 2 节提到「写临时文件 `os.tmpdir()/...txt` … 跑完 unlink」，
> 同时写明「优先验证 stdin」。本机实测 stdin 直连即可（见下「实测」），无需落临时文件——直接
> `stdin.write(prompt)` 既避开 cmd 重分词，又无 argv 长度上限，还省去文件 I/O 与 finally 清理。
> 故未实现临时文件路径；若将来遇到 stdin 不吃的 CLI 再补 `--prompt-file` / 临时文件 argv 兜底。

### 3. 寒暄软失败

`finalize`：计算 `ok/summary` 后，若 `ok && toolCalls===0 && isGreetingSummary(summary)` →
`ok=false`，`summary = '[cli-worker] kscc 未执行任务（疑似 prompt 未送达）: <原 summary>'`。
匹配：`/请告诉我你需要做/`、`/请告诉我您需要/`、`/请告诉我你需要什么帮助/`、`/What would you like/i`。
已调用工具（`toolCalls>0`）时不触发（非空转寒暄）。

### 4. 日志

spawn 前一行（不打全文 prompt）：
`[cli-worker] spawn command=<cmd> argsCount=N promptChars=M via=<node|exe|cmd|unix> delivery=<argv|stdin>`

## 实测（本机，kscc 1.1.28 独立 .exe 分发）

本机 `%AppData%\Roaming\npm\kscc.cmd` 内部调 `kscc.exe`，**无** `cli-wrapper.js` → `planKsccWindowsSpawn`
返回 null → 走 cmd 兜底 + stdin（正是修复要救的场景）。

| 路径 | 命令形态 | 结果 |
| --- | --- | --- |
| 新（修复） | `cmd /c kscc.cmd <flags>` + prompt 走 **stdin** | `result` = `PING_OK` ✓ |
| 旧（bug） | `cmd /c kscc.cmd <flags> "Reply with exactly: PING_OK"`（prompt 在 argv） | 挂起/乱码 ✗（cmd 重分词） |

另：`echo "Reply with exactly: PING_OK" | kscc -p --bare -y --output-format stream-json --verbose --model glm-5.2`
（bare 名经 PATH → kscc.cmd + stdin）同样回 `PING_OK`，确认 stdin 通道可靠。

## 单测

`run-kscc-worker.test.ts`：19 用例。`vi.mock` 掉 `resolveBinOnPath` / `planKsccWindowsSpawn` /
`spawn`，并 `Object.defineProperty(process,'platform','win32')` 强制 Windows 路径（跨平台确定性）。

- 既有行为不回归：exit0+result、exit≠0+stderr、onProgress、abort kill、已 abort 不 spawn、
  spawn 抛错、child error、传/不传 model（prompt 末位）。
- Windows 投递：node 计划 → command 是 `node.exe` 非 `cmd.exe`；plan 返回 null → `cmd.exe` + stdin、
  prompt 不入 argv；长 prompt(>4000) / 含换行 → stdin；bare 解析失败 → cmd+stdin；解析到 `.exe` →
  直 spawn .exe、prompt 在 argv 末位。
- 寒暄：命中「请告诉我你需要做什么」/「What would you like」+ toolCalls===0 → `ok:false`+前缀；
  toolCalls>0 不触发；正常 result 不受影响。

`resolve-bin-on-path.test.ts`：7 用例。`.cmd` 优先、`.exe` 次、仅 shim → null、where 抛错 → null、
路径输入 existsSync 判定、空串 → null。

兄弟不回归：`kscc-stream-observer.test.ts` / `resolve-backend.test.ts` 仍绿。
cli-workers 目录 4 文件、43 用例全绿：

```
node node_modules/vitest/dist/cli.js run apps/electron/src/main/lib/agent/cli-workers
Test Files  4 passed (4)   Tests  43 passed (43)
```

## typecheck

`apps/electron` `tsc --noEmit`：**本次改动文件 0 错误**。
工作树存在 3 个既有错误，均不在本次文件、属其它在途改动（moa 多 speaker / sidebar），未由本次引入，
按 brief「禁止改设置 UI / 改配置 schema / 大重构 pi-agent-adapter」不越界处理：

- `apps/electron/src/renderer/components/chat/Chat.tsx(708,62)` TS2353 `modelId`
- `apps/electron/src/renderer/components/chat/Chat.tsx(2788,11)` TS2322 `AssistantTurnViewProps`
- `apps/electron/src/renderer/components/workspace/SessionSidebar.tsx(442,56)` TS2322 `MouseEventHandler`

## 验收对照

- [x] Windows 上不再默认 `cmd.exe /c` + 裸 prompt（bare 名先解析绝对路径；cmd 兜底时 prompt 走 stdin）
- [x] 长 prompt / 含换行 → stdin
- [x] 寒暄检测 → `ok:false` + 前缀
- [x] spawn 前一行日志（command/argsCount/promptChars/via/delivery，不打全文 prompt）
- [x] 单测绿（43/43 cli-workers；run-kscc-worker 19 + resolve-bin-on-path 7）
- [x] typecheck 本次文件 0 错
- [x] 实测：本机短 prompt 经修复路径回 `PING_OK`（旧路径挂起）
- [x] 写 `docs/dev/cli-workers/FIX-prompt-delivery-DONE.md`
- [x] 未 git commit

## 设计取舍备忘

- `resolveBinOnPath` 抽成独立模块（而非内联）便于 `vi.mock`，且测试可跨平台（Linux CI 无 `where.exe`）。
- `via` 用四值（node/exe/cmd/unix）+ `delivery` 二值（argv/stdin）分别表达「命令通道」与「prompt 投递」，
  比 brief 建议的 `via=node|cmd|stdin` 更明确；日志同时打两者。
- 寒暄检测放 `finalize` 末尾、对所有平台生效（不只 Windows）——作为「prompt 未送达」的统一安全网，
  无副作用（仅当 `ok && toolCalls===0` 才可能触发）。
