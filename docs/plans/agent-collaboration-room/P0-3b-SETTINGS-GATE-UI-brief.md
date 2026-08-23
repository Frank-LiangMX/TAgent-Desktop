# P0-3b · 打包闸门「显式用户操作」设置页 + 闸门状态接线

> **角色**：实现 agent（kscc）  
> **模型建议**：`kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> **仓库根**：`main`（本地 ahead：P0-1..P0-3 已提交未 push）  
> **上游**：[`P0-3-CERT-AND-PACKAGED-GATE-brief.md`](./P0-3-CERT-AND-PACKAGED-GATE-brief.md)、`fusion-room-network-prefs*.ts`、`SettingsPage.tsx` About/General 样式  

---

## 目标

把 P0-3 已落地的 **prefs IPC + 证书 IPC** 接到用户可操作的设置页「危险区」，并补齐闸门状态可读性。  
**默认仍全关**；**不要**在本切片自动对公网/`0.0.0.0` 起监听。

交付：

1. **设置 UI**：高级 / 关于（或新建 advanced 子区）增加「融合会话 · 协作与网络」危险区  
   - Switch：`enableCollaboration`（打包版启用协作室 IPC）  
   - Switch：`enableNetworkListen`（允许非 loopback；无 active 证书时禁用控件并提示先生成证书）  
   - 证书列表（fingerprint 短显、status、过期时间）+「生成自签证书」+「撤销」  
   - 醒目警告文案：默认关闭；开启网络不等于真实账户认证已完成；重启可能仍需要（见下）  
2. **闸门状态查询**：IPC `fusion-room-network-prefs:gate-status`（或等价）返回  
   `decidePackagedCollaborationGate({ isPackaged, prefs, hasActiveCert })` 的结果，设置页只读展示「当前 IPC / 非 loopback 是否实际放行」。  
3. **偏好变更后的应用策略（选改动更小且正确的一种，并在 §75 写明）**：  
   - **推荐 A**：打包版从关→开 `enableCollaboration` 时，若尚未注册协作室 IPC，则**动态** `registerCollaborationRoomIpc`（注意 handler 重复注册：需守卫或先检查）；从开→关时**不要**暴力乱卸所有 ipc（易漏），可提示「关闭需重启生效」并在日志标明。  
   - **或 B**：所有闸门变更提示「重启应用后生效」，设置页显示待重启徽章；实现更简单，但必须在 UI 说清楚。  
4. **单测**：prefs/gate-status 逻辑；可选 React 组件对模型函数的轻量测（不要依赖真实 Electron 窗口）。  
5. **文档**：`12` §75；`13-HANDOFF` §8 第 3 步标「显式用户操作 UI 已落地，默认仍关」；`03` 一句。

---

## 允许

- 新增例如：
  - `apps/electron/src/renderer/components/settings/FusionRoomNetworkSettings.tsx`
  - 可选 `fusion-room-network-settings-model.ts` + `.test.ts`（纯展示/禁用逻辑）
- 改 `SettingsPage.tsx`：在 `AboutSettings` 底部挂危险区（推荐，避免新 tab 膨胀），或 advanced 新 tab——选一种并保持现有视觉（`SettingsSection` / `settings-row` / `Switch`）。  
- 扩展 `fusion-room-network-prefs-ipc.ts` + preload `electronAPI` + `App.tsx` 全局类型（gate-status）。  
- 小改 `main/index.ts` 以支持动态注册或统一读 gate（若选策略 A）。

---

## 禁止

- 默认打开任何开关  
- 自动 `start({ host: '0.0.0.0' })` / 公网监听  
- 新增 `allowInsecureNetwork`  
- 大改协作室主 UI / 远程页  
- 声称真实账户或跨机器已可用  
- **可以 commit，不要 push**；勿动无关 `tokens.css`

---

## UX 约束

- 危险区标题明确，副文案说明：打包版默认关闭协作；网络监听还需证书；无真实账户认证前仅限受信局域网试验。  
- `enableNetworkListen` 在 `!enableCollaboration` 或 `!hasActiveCert` 时 **Switch disabled**。  
- 生成证书成功后刷新列表与 gate-status。  
- 撤销当前唯一 active 证书后，若 `enableNetworkListen` 仍为 true，gate-status 应显示非 loopback **未**放行（已有决策函数语义）。  
- 不要在 UI 展示私钥。

---

## 验证

```powershell
bun test apps/electron/src/main/lib/collaboration/fusion-room-network-prefs.test.ts
bun test apps/electron/src/main/lib/collaboration/fusion-room-cert-store.test.ts
# 若新增 model 测试：
bun test apps/electron/src/renderer/components/settings/fusion-room-network-settings-model.test.ts

bun run --filter='./apps/electron' typecheck
git diff --check
```

本环境**没有**可用的 Electron GUI / 浏览器 MCP。UI 行为用组件模型单测 + typecheck 验证；在 §75 写明「未做实机点击设置页手测」。主控 agent 会再独立跑测试。

---

## 完成输出

1. 文件列表  
2. 策略 A 或 B 的选择与原因  
3. 测试结果  
4. 明确未做：真实账户、自动公网 listen、跨机器 E2E、完整远程设置  
5. §75 + handoff；commit hash；**勿 push**

先读 P0-3 已有 IPC/preload API、`AboutSettings` 结构与 Switch 用法，再实现。
