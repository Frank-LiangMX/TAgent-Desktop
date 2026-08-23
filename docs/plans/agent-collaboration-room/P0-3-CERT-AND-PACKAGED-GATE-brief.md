# P0-3 · 证书生命周期 + 打包版网络显式闸门（默认关闭）

> **角色**：实现 agent（kscc）  
> **模型建议**：`kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> **仓库根**：当前 `main`（本地已有 P0-1 `e139243`、P0-2 `c36bcbd`，ahead of origin）  
> **上游**：[`13-HANDOFF` §7 P0-2 / §8 第 3 步](./13-HANDOFF-2026-08-23.md)、现有 `fusion-room-runtime.ts` TLS/loopback 闸门、`apps/electron/src/main/index.ts` 打包协作闸门  

---

## 目标

交付两块**可单测、默认关闭**的能力，为后续跨机器 E2E 铺路，但**绝不**在本切片打开公网或默许打包版监听：

### A. 证书生命周期（本地 store + 纯协议）

- 生成 / 加载 / 轮换 / 撤销 RoomSession 服务端 TLS 材料的本地存储（开发/自托管用 self-signed 或用户提供 PEM 均可）。  
- 输出可直接喂给现有 `FusionRoomTlsOptions`（`key` / `cert`，可选 `ca` / `requestCert` / `rejectUnauthorized`）的材料。  
- 元数据：`certId`、`createdAt`、`expiresAt`、`revokedAt`、`fingerprint`（或 sha256）、`status: active|revoked|expired`。  
- **撤销 / 过期的证书不得再用于 `start({ host: 非 loopback })`**；明文 HTTP + 非 loopback 仍一律拒绝（现有 `isFusionRoomLoopbackHost` 不放宽）。

### B. 打包版协作 / 网络显式闸门（默认关闭）

当前 `main/index.ts`：`if (!app.isPackaged) registerCollaborationRoomIpc(...)` —— 打包版完全关闭。

本切片改为**可配置但默认关闭**的决策函数 + 持久化偏好，例如：

```ts
decidePackagedCollaborationGate({
  isPackaged: boolean
  prefs: {
    /** 打包版是否注册协作室 IPC / 本地房间 UI 入口；默认 false */
    enableCollaboration?: boolean
    /** 打包版是否允许启动非 loopback FusionRoom transport；默认 false；仅当 enableCollaboration 且有未撤销 TLS 证书时才可能为 true */
    enableNetworkListen?: boolean
  }
}): {
  registerIpc: boolean
  allowNonLoopbackListen: boolean
  reasons: string[]
}
```

规则：

1. **开发环境**（`!isPackaged`）：`registerIpc=true`；非 loopback 仍要求 TLS（由 runtime 现有逻辑保证）。  
2. **打包版默认**：`registerIpc=false`，`allowNonLoopbackListen=false`（与今天行为一致）。  
3. 仅当用户**显式**打开 `enableCollaboration` 时，打包版才注册 IPC（本地协作可用）。  
4. `enableNetworkListen` 必须额外满足：显式打开 + 存在 **active 且未过期** 的 TLS 证书材料；否则 false。  
5. **禁止**新增 `allowInsecureNetwork` / 明文公网监听开关。

最小接线（够用即可，勿做大 UI）：

- 持久化偏好文件（可放 `getConfigDir()` 下，例如 `fusion-room-network-prefs.json`）。  
- IPC：`get` / `set` 偏好（set 时校验上述规则）；可选 `certs:list|generate|revoke`。  
- `index.ts`：用 `decidePackagedCollaborationGate` 替代硬编码 `!app.isPackaged`；**默认 prefs 全关 → 打包行为不变**。  
- Renderer：**不要**大改页面；若完全没有设置入口，可只落主进程 + 单测，并在文档写明「UI 开关属后续切片」。允许在设置页加一个很小的危险区开关（可选加分），默认关、带文案警告。

---

## 建议文件

新增（名称可微调）：

- `apps/electron/src/main/lib/collaboration/fusion-room-cert-store.ts`  
- `apps/electron/src/main/lib/collaboration/fusion-room-cert-store.test.ts`  
- `apps/electron/src/main/lib/collaboration/fusion-room-network-prefs.ts`（prefs + `decidePackagedCollaborationGate`）  
- `apps/electron/src/main/lib/collaboration/fusion-room-network-prefs.test.ts`  

可能修改：

- `fusion-room-runtime.ts`：提供从 cert store 解析 `tls` 的 helper（可选）；**不**改变 loopback 明文拒绝语义。  
- `main/index.ts`：闸门改为决策函数。  
- `collaboration-ipc.ts` 或独立小 ipc 模块：prefs/certs handlers（若放 collaboration-ipc，注意打包未注册时这些 handler 也不存在——符合「关闸」）。  
- 顺手修 `fusion-room-runtime.test.ts` 里 Bun 下 `instanceof HttpsServer` 误报（用 `server.constructor.name` / `listening`+`tls` 选项断言，或 `node:https` 创建后检查 `server instanceof HttpServer` 且存在 `_tls`/`setSecureContext` 等稳定信号）。**不要删安全断言**，只换在 Bun/Node 都稳的探测方式。

文档：

- `12-IMPLEMENTATION-LOG` 追加 **§74**  
- `13-HANDOFF` §7 P0-2 / §8 第 3 步旁注：证书 store + 显式闸门已落地，**默认仍关闭**；真实账户/跨机器仍未做  
- 轻量更新 `03` 一句

---

## 禁止

- 默认打开打包版协作或网络监听  
- 明文 HTTP 绑定 `0.0.0.0` / 公网  
- 把自签证书宣传成“生产 CA / 已完成真实账户”  
- 大改远程 UI、重写 authority  
- **可以 commit，不要 push**  
- 不要动无关 `tokens.css`

---

## 证书实现约束

- 优先用 Node 内置 `node:crypto`（或项目已有依赖）生成自签；**不要**新增重型 CA 库，除非仓库已有且 brief 外依赖可接受。  
- 磁盘只存必要 PEM + 元数据；secret 权限按现有 atomic-json / config 目录惯例。  
- `generate` 产出后标记 active；`rotate` = 新 active + 旧标 revoked（或 expired）；`revoke(certId)` 立即失效。  
- 单测用临时目录，不写用户真实 config。

---

## 必须覆盖的测试

1. `decidePackagedCollaborationGate`：dev 开 IPC；packaged 默认全关；仅 enableCollaboration → IPC 开但非 loopback 仍关；enableNetworkListen 无证书 → 仍关；有 active 证书 + 双开关 → allowNonLoopbackListen true；revoked/expired 证书 → false。  
2. cert store：generate → list active；revoke → 不可再 resolveTlsOptions；rotate 后旧 fingerprint 失效、新的可用；过期（用注入 `now`）视为不可用。  
3. runtime 回归：无 tls + 非 loopback 仍 reject；有 tls 选项（可用 store 产出的材料或最小自签 fixture）可在 loopback start/close。  
4. Bun HTTPS 探测用例在本机 `bun test ...fusion-room-runtime.test.ts` **不再**因 instanceof 误失败（若你修了它）。

---

## 验证命令

```powershell
bun test apps/electron/src/main/lib/collaboration/fusion-room-network-prefs.test.ts
bun test apps/electron/src/main/lib/collaboration/fusion-room-cert-store.test.ts
bun test apps/electron/src/main/lib/collaboration/fusion-room-runtime.test.ts
bun test packages/core/src/collaboration/fusion-room-acl.test.ts
bun run --filter='@tagent/core' typecheck
bun run --filter='./apps/electron' typecheck
git diff --check
```

---

## 完成输出

1. 文件列表与闸门默认仍关闭的证据（测试或代码路径）  
2. 测试结果  
3. 明确未做：真实账户 OAuth、跨机器 E2E、生产 CA、完整设置 UI（若未做）  
4. §74 + handoff 旁注  
5. commit hash（若 commit）；**勿 push**

开始前读 `fusion-room-runtime.ts` 的 tls/loopback 注释、`main/index.ts` 闸门、`13-HANDOFF` §8 第 3 步。不要声称打包版已默认可被公网访问。
