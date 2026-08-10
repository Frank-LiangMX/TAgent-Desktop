# FIX · kscc 工人 prompt 投递（Windows 不拆词）

> 总监 brief。`kscc -p --model glm-5.2` 实现。勿 git commit。

## 现象（已证实）

外渠 Pi `task` → `runKsccWorker` 后，tool_result 三次都是 kscc 开场白「请告诉我你需要做什么」，任务未执行。  
根因：`planSpawnCommand` 对 bare `kscc` 走 **`cmd.exe /c kscc ... <prompt>`**，cmd 重分词，prompt 被拆坏。  
短句实测：`Reply with exactly: PING_OK` 经 shell 后 kscc 只看到 `Reply`。

## 必须改

文件：`apps/electron/src/main/lib/agent/cli-workers/run-kscc-worker.ts`（+ 单测）

### 1. Windows **禁止**用 `cmd.exe /c` 传长 prompt

优先：

1. 若 `bin` 是 bare 名（如 `kscc`）：用 `where.exe kscc` / 或读 `process.env.PATH` 解析出 **`kscc.cmd` 绝对路径**（可抽小函数 `resolveBinOnPath`）
2. 对 `*.cmd`：调用已有 `planKsccWindowsSpawn(cmdPath, args)` → **`node.exe` + `cli-wrapper.js` + args**（argv 数组，Node 不分词）
3. 解析失败才 fallback；fallback 也尽量不要把未转义 prompt 塞进 `cmd /c`

非 Windows：保持 `spawn(bin, args)` 即可。

### 2. prompt 投递（双保险）

- **主路径**：prompt 仍作 **最后一个 argv**（在 node 直连时安全）
- **若 prompt 很长（如 > 4000）或含换行**：写临时文件 `os.tmpdir()/tagent-cli-worker-*.txt`，改用 **stdin** 喂入：
  - argv **不要**再带 prompt 字符串
  - `stdio: ['pipe','pipe','pipe']`
  - `child.stdin.write(prompt); child.stdin.end()`
  - 确认 kscc `-p` 无位置 prompt 时从 stdin 读 text（help：`--input-format text` 默认）
  - 跑完 `unlink` 临时文件（finally）

若实测 stdin 不吃，改用：临时文件路径作为唯一 argv prompt 不可行则文档说明；优先验证 stdin。

快速自测（实现后可 live 可选）：

```
# node 直连或修好的 spawn：
# 应输出 PING_OK，不能是「只有 Reply」
```

### 3. 寒暄检测（软失败）

`finalize` 时：若 `ok` 且 `toolCalls===0` 且 summary 匹配：

- `/请告诉我你需要做/`
- `/请告诉我您需要/`
- `/请告诉我你需要什么帮助/`
- `/What would you like/i`

→ 改为 `ok: false`，summary 前缀：`[cli-worker] kscc 未执行任务（疑似 prompt 未送达）: `

便于主 Agent / 入口卡显示失败，而不是当成功报告。

### 4. 日志

spawn 前 `console.log` 一行（勿打全文 prompt）：

`[cli-worker] spawn command=... argsCount=... promptChars=N via=node|cmd|stdin`

### 5. 单测更新

`run-kscc-worker.test.ts`：

- mock 下断言 **Windows 路径**：若 platform win32，spawn 的 command **不应**是 `cmd.exe`（当能 mock resolve 到 .cmd + planKsccWindowsSpawn）；或 mock `planKsccWindowsSpawn` 返回 node 计划并断言用了它
- 寒暄 summary → ok:false
- 现有 exit0/abort 测仍绿

可用 `vi.mock` 对 `kscc-windows-spawn` / path resolve。

## 验收

- [ ] Windows 上不再默认 `cmd.exe /c` + 裸 prompt  
- [ ] 单测绿  
- [ ] 可选：本机 `RUN_KSCC_LIVE=1` 或手测短 prompt 回 `PING_OK`  
- [ ] 写 `docs/dev/cli-workers/FIX-prompt-delivery-DONE.md`  
- [ ] 不 git commit  

## 禁止

- 改设置 UI、改配置 schema  
- 大重构 pi-agent-adapter  
