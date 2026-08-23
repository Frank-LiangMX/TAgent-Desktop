# P0-2 · 双用户 / 双 Bot owner / 共享工作区 HTTP·SSE fixture E2E

> **角色**：实现 agent（kscc）  
> **模型建议**：`kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> **仓库根**：当前工作目录（`main`）  
> **上游**：
> - [`13-HANDOFF-2026-08-23.md`](./13-HANDOFF-2026-08-23.md) §8 第 2 步  
> - [`P0-1-ACL-PROTOCOL-brief.md`](./P0-1-ACL-PROTOCOL-brief.md)（已合入 `e139243`）  
> - 现有 `fusion-room-http-server.test.ts` / `fusion-room-runtime.test.ts` / `fusion-room-acl.ts`

---

## 目标

用**内存/本地 loopback fixture**跑通一条跨用户垂直切片（不是公网、不是打包网络入口）：

```text
用户 A（房主）创建 RoomSession
  → 签发邀请 token 绑定用户 B 身份
  → B 用 Bearer token 接受邀请并进入
  → A 加入自己的 Bot（owner=A，自动/显式 consent）
  → A 代邀请 B 的 Bot（owner=B）但不可代签 consent
  → B 亲自 bot-consent 后，B 的 Bot 才可运行
  → 共享工作区：A 锁/写/发布可下载文件；B 作为成员可下载
  → 未授权 outsider / 错绑 token room scope / 无 consent 的 Bot 动作被拒绝
  → usage / billing 语义：费用主体仍是各自 Bot owner（可用 authority 或 ACL resolveBillingSubject 断言）
  → （可选加分）B 订阅 SSE，能收到 A 侧动作产生的事件增量
```

**验收**：新增（或显著扩展）一个可独立运行的测试文件；全程仅 `127.0.0.1`；复用现有 Host/Gateway/HTTP server/invite store/workspace 能力；**不打开打包版公网入口**。

---

## 建议落点

优先二选一（选改动面更小的）：

1. **推荐**：`apps/electron/src/main/lib/collaboration/fusion-room-multiuser-fixture.test.ts`（新文件，纵向 fixture）  
2. 或扩展 `fusion-room-runtime.test.ts`，但必须单独 `describe('multiuser fixture E2E')`，勿把现有用例搅乱。

认证方式：

- 可继续用测试用 `x-user-id` header（现有 http-server test 已用）**加上** invite Bearer 路径（runtime test 已有签发/接受）。  
- 邀请 token 必须绑定 `userId` + `roomId`：用 B 的 token 不能冒充 A；绑定 room-A 的 token 不能进 room-B（若 server 已支持 principal.roomId，断言之；缺口则最小补齐 authenticate → principal.roomId 注入，**不要**借机做 OAuth）。

Bot / consent / workspace：

- 通过 gateway HTTP `actions`：`add-bot` / `bot-consent` / `lock` / `commit-file`（`downloadable: true`）/ `usage`（若 HTTP 暴露）或直接对同一 host 断言 usage 账本。  
- 若 HTTP action 集合已覆盖这些 type，优先纯 HTTP；缺哪个就只补服务端 action 路由缺口，不重写 transport。

ACL：

- 房间拒绝路径应与 P0-1 `decideRoomAccess` 一致（gateway 已委托）。  
- Bot consent / billing 可用 `decideBotRuntimeAccess` / `resolveBillingSubject` 做旁路断言，或直接读 snapshot 字段；不要重复发明第二套规则。

---

## 允许

- 新增上述测试文件与必要的小 helper（发 action、读 snapshot、下载文件、读 SSE 几条）。  
- 若 invite authenticate 未把 `roomId` 写入 `FusionRoomPrincipal`，做**最小**接线让 token 恢复的 principal 带 `roomId`（并补单测）。  
- 更新文档：
  - `12-IMPLEMENTATION-LOG-2026-08-22.md` 追加 **§73**
  - `13-HANDOFF-2026-08-23.md` 旁注 §7/§8：本地双用户 fixture 已有；真实账户/证书/跨机器仍未做
  - 必要时轻量改 `03` / `06` 一句状态

---

## 禁止

- 打开 packaged network gate / 默认监听非 loopback / 证书“假装生产可用”  
- 真实 OAuth、云账户、跨机器部署  
- 大改 renderer UI  
- 改无关 `tokens.css` 等  
- **可以 commit，不要 push**

---

## 必须覆盖的断言（最低集）

1. A 创建房间；未邀请的 outsider `GET`/`actions` → 403。  
2. A 签发 invite（`userId=B`）；B 用 Bearer 接受邀请成功；用错误 user 的伪造头不能靠 token 变身（token 身份优先于随意 header，若当前实现是「仅 Bearer 或仅 header」，按现实现写清并测 token 路径）。  
3. A 添加 `ownerUserId=A` 的 Bot，可消息/可记 usage，billing=`A`。  
4. A 添加 `ownerUserId=B` 的 Bot 时不能自动视为已 consent（或只能带 pending）；在 B consent 前，针对该 seat 的运行/写相关动作失败（按现有 authority 错误即可）。  
5. B `bot-consent` 后该 seat 可 `append`/`start-run` 路径中已暴露的动作成功（选 authority 已支持且 HTTP 已暴露的最小动作）。  
6. 共享工作区：A 发布 `downloadable` 文件后，B 可下载到相同内容；非 `downloadable` 对 B 不可下。  
7. （加分）SSE：B 订阅后，A 发消息或状态变更，B 能读到至少一条相关 event。

---

## 验证命令

```powershell
# 新 fixture（按你实际文件名调整）
bun test apps/electron/src/main/lib/collaboration/fusion-room-multiuser-fixture.test.ts

# 回归
bun test apps/electron/src/main/lib/collaboration/fusion-room-http-server.test.ts
bun test apps/electron/src/main/lib/collaboration/fusion-room-runtime.test.ts
bun test packages/core/src/collaboration/fusion-room-acl.test.ts
bun test packages/core/src/collaboration/fusion-room-gateway.test.ts

bun run --filter='@tagent/core' typecheck
# electron 侧若有现成 typecheck script 也跑一下；失败如实记录
git diff --check
```

若 Electron 测试被 safeStorage ESM mock 挡住：优先用项目既有 vitest/electron 入口；仍不行就在 §73 写明阻塞与复现命令，**不要**删安全检查装通过。

---

## 完成输出

1. 文件列表  
2. 测试命令与结果  
3. 明确未做（真实账户、证书、跨机器、公网入口）  
4. 文档 §73 / handoff 旁注  
5. 若 commit：hash；**勿 push**

先读 `13-HANDOFF` §8、现有 http-server/runtime 测试与 invite-token-store，再动手。不要声称跨机器可用。
