# P0-3c · Electron 启动接通 FusionRoom transport（据闸门 + TLS，默认仍关）

> **角色**：实现 agent（kscc）  
> **模型建议**：`kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> **仓库根**：`main` @ `34d7870`（或当前 HEAD）  
> **上游**：P0-3 / P0-3b（`decidePackagedCollaborationGate`、`FusionRoomCertStore.resolveTlsOptions`、设置危险区 UI）、`fusion-room-runtime.ts`、`main/index.ts` 仅 `console.log` 占位、[`13-HANDOFF` §8 第 3 步旁注](./13-HANDOFF-2026-08-23.md)

---

## 目标

把 **P0-3 已产出但未接通** 的 `allowNonLoopbackListen` 接到 Electron 主进程启动路径：

1. 闸门允许时：用 cert store 的 active TLS 材料构造 `createFusionRoomTransportRuntime({ tls })`，并按偏好监听（可非 loopback）。  
2. 闸门不允许时：**不**创建 runtime、**不** listen（与今天默认打包行为一致）。  
3. 暴露只读状态 IPC（监听地址 / 是否 TLS / 为何未启动），供设置页危险区或后续 UI 读取。  
4. **绝不**默认打开公网；**绝不**新增 `allowInsecureNetwork`；远程路径 **不** 默认 `enableDefaultMemberExecution`。

本切片是「启动接线 + 可测」，**不是**真实账户 OAuth、**不是**跨机器实机 E2E、**不是**大改远程 UI。

---

## 现状（必须尊重）

`main/index.ts` 今日行为：

```ts
if (fusionGate.registerIpc) {
  registerCollaborationRoomIpc(...)
  if (fusionGate.allowNonLoopbackListen) {
    console.log('[collaboration] 非 loopback 监听已获显式授权（active 证书 + 双开关）')
    // ← 仅日志，未 createFusionRoomTransportRuntime / start
  }
}
```

- `FusionRoomCertStore.resolveTlsOptions()` 已存在：仅 active 未过期证书返回 `FusionRoomTlsOptions`。  
- `createFusionRoomTransportRuntime`：有 `tls` 才允许非 loopback `start`；明文 + 非 loopback 仍 reject。  
- `enableDefaultMemberExecution` 默认 false（远程/打包 authority-only）。  
- 工作区有**未提交**的 Sidecar / lightbox / message / tokens 改动——**禁止触碰**这些文件。

---

## 设计

### A. 启动装配（建议新模块，保持 `index.ts` 薄）

新增例如：

`apps/electron/src/main/lib/collaboration/fusion-room-transport-bootstrap.ts`

```ts
export type FusionRoomTransportBootstrapResult =
  | { status: 'disabled'; reasons: string[] }
  | { status: 'loopback_only'; runtime: FusionRoomTransportRuntime; address: AddressInfo; tls: false }
  | { status: 'listening'; runtime: FusionRoomTransportRuntime; address: AddressInfo; tls: true; host: string }
  | { status: 'failed'; error: string; reasons?: string[] }

export async function bootstrapFusionRoomTransport(input: {
  gate: { registerIpc: boolean; allowNonLoopbackListen: boolean; reasons: string[] }
  certStore: FusionRoomCertStore
  /** 非 loopback 时绑定主机；默认 '0.0.0.0'；测试传具体地址 */
  listenHost?: string
  /** 端口；默认 0（OS 分配）或 prefs 里已有字段则读 prefs；测试用 0 */
  listenPort?: number
  /**
   * 开发态（!isPackaged && registerIpc）是否可选启动 **loopback-only** HTTP transport。
   * 建议：**本切片默认 false**（避免无显式开关就起服务）。
   * 仅当 `allowNonLoopbackListen===true` 时必须启动 HTTPS + 非 loopback（或 prefs 指定 host）。
   */
  enableDevLoopbackTransport?: boolean
}): Promise<FusionRoomTransportBootstrapResult>
```

规则：

| 条件 | 行为 |
|---|---|
| `!gate.allowNonLoopbackListen` | **不** start 非 loopback；返回 `disabled`（reasons 含闸门理由）。本切片**默认也不**自动起 loopback HTTP（除非显式 `enableDevLoopbackTransport`，且仅 127.0.0.1，无 tls）。 |
| `gate.allowNonLoopbackListen` 且 `resolveTlsOptions()` 有值 | `createFusionRoomTransportRuntime({ tls, enableDefaultMemberExecution: false })` → `start({ host: listenHost ?? '0.0.0.0', port })` → `listening` |
| `gate.allowNonLoopbackListen` 但无 TLS 材料 | `failed` 或 `disabled`（不得明文非 loopback）；不得绕过 |
| `start` reject / listen 失败 | `failed`，打日志，**不**崩主进程 |

生命周期：

- 模块级或返回句柄持有 runtime；`app.on('before-quit' / 'will-quit')` 调 `runtime.close()`。  
- 策略仍对齐 P0-3b **B**：闸门变更需重启才重新 bootstrap（不在本切片做热插拔 listen）。

### B. `main/index.ts` 接线

在现有 `fusionGate` 计算之后：

```ts
const bootstrap = await bootstrapFusionRoomTransport({ gate: fusionGate, certStore: fusionCertStore, ... })
// 把 bootstrap 摘要交给 prefs IPC 或独立 transport-status IPC
```

删除「仅 console.log 占位」；改为记录真实 bootstrap 结果。

### C. 状态 IPC（只读）

扩展 `fusion-room-network-prefs:gate-status` **或** 新增 `fusion-room-transport:status`：

```ts
{
  appliedGate: { registerIpc, allowNonLoopbackListen, reasons }
  transport: {
    status: 'disabled' | 'listening' | 'loopback_only' | 'failed' | 'not_started'
    host?: string
    port?: number
    tls?: boolean
    error?: string
  }
}
```

preload + `App.tsx` 类型同步。设置页危险区：**可选**加一行只读「传输：未启动 / 监听 https://host:port」——最小文案即可，**不要**大改 UI。

### D. 单测（重点）

`fusion-room-transport-bootstrap.test.ts`（临时目录 + port 0）：

1. `allowNonLoopbackListen=false` → 不 listen、无 server。  
2. `true` + 临时生成 active 证书 → HTTPS listen 成功；用 `node:https`/`fetch` 或现有 http-client 探活（可只断言 `address.port > 0` + `tls===true`）。  
3. `true` 但 cert store 无 active → 不 listen 非 loopback、返回 failed/disabled。  
4. 明文路径：`enableDevLoopbackTransport=true` 时仅 127.0.0.1 可起；若误传非 loopback 无 tls → 与 runtime 一致 reject。  
5. `close()` 后端口释放（可选）。  
6. **断言** `enableDefaultMemberExecution` 未打开（runtime 无 executionBridge / 或构造选项为 false）。

禁止：测试里绑定真实公网、写入用户真实 `getCollaborationDir()` 而不用临时 path。

---

## 禁止

- 默认 prefs 下自动起非 loopback / 公网监听  
- 新增 `allowInsecureNetwork` 或明文非 loopback  
- 远程/打包路径默认 `enableDefaultMemberExecution=true`  
- 真实 OAuth / 账户系统 / 生产 CA  
- 声称「跨机器 E2E 已完成」  
- 触碰未提交文件：`BotSidecarPanel.tsx`、`BotSidecarPanel.test.tsx`、`image-lightbox.tsx`、`message/index.tsx`、`tokens.css`  
- 擅自 `git push`（**可以 commit**）

---

## 文档

完成时更新：

1. `12-IMPLEMENTATION-LOG-2026-08-22.md` 追加 **§83**  
2. `13-HANDOFF-2026-08-23.md` §3 / §7 / §8 旁注：P0-3c 已接通；默认仍关；真实账户/跨机器仍未做  
3. `03-IMPLEMENTATION-PHASES.md` §0.2 基线补一句  

---

## 验证

```powershell
bunx vitest run apps/electron/src/main/lib/collaboration/fusion-room-transport-bootstrap.test.ts
bunx vitest run apps/electron/src/main/lib/collaboration/fusion-room-network-prefs.test.ts
bunx vitest run apps/electron/src/main/lib/collaboration/fusion-room-runtime.test.ts
bun run --filter='./apps/electron' typecheck
git diff --check
```

无 Electron GUI：不要求实机点设置页；§83 注明未实机手测。

---

## 完成输出（回给总监）

1. 文件列表  
2. bootstrap 决策表（何条件下 listen）  
3. 测试结果原文  
4. 明确未做：OAuth、跨机器 E2E、热插拔 listen、member execution 默认开  
5. §83 + handoff/03 更新；commit；勿 push  
`
