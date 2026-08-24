# 单会话 ↔ 协作室桥接规格

> 状态：已定产品方向（2026-08-23）  
> 交接入口：[13-HANDOFF-2026-08-23](./13-HANDOFF-2026-08-23.md)  
> 本轮契约实现 brief：[P2-UX-BRIDGE-ENTER-EXIT-CONTRACT-brief.md](./P2-UX-BRIDGE-ENTER-EXIT-CONTRACT-brief.md)

## 1. 产品结论

**不把单会话全线改成 room。** 保留两套运行时：

| 模式 | 运行时 | 用户感知 |
| --- | --- | --- |
| 单会话（0～1 Bot，未开启协作） | 现有 kscc 长线程 + 记忆栈 | 连续 1:1 对话 |
| 协作期（明示开启后） | 真协作室 RoomSession + 调度 / A2A | 同一会话标签内的协作模式 |

桥接规则：

1. **sessionId 固定**：原单会话身份不变；完整消息历史始终挂在该 session。  
2. **明示开关**：升级为协作必须用户确认「开启协作」，禁止静默自动升。  
3. **开启后**：创建（或幂等复用）真协作室；把单会话上下文**精炼**为前情提要写入房间背景；`sourceSessionId = 原 sessionId`。  
4. **协作期间**：原单会话**无独立 UI 入口**（避免双入口）；用户只在协作壳里操作。  
5. **对不上时**：协调者通过**受控工具**按需读取原 session 摘录，禁止每轮整包塞原 JSONL。  
6. **退出**：用户主动退出，或成员只剩「用户 + 协调者」时**弹确认**（勿静默），精炼协作结论**写回**原 session，再恢复单会话 UI / 长线程。

## 2. 精炼预算（token）

相对模型上下文窗口比例 + 硬顶。中文约 1 字 ≈ 1–1.5 token。

| 步骤 | 默认 | 硬顶 | 说明 |
| --- | --- | --- | --- |
| 进房前情提要 | **3000** | **8000** | 启动团队用；结构化模板，非全文复制 |
| 协调者按需读原史 | **每次 1000–2000** | **单轮合计 ≤4000** | `read_source_session_excerpt` |
| 回写单会话 | **2000** | **6000** | 宁短勿长，保护长线程 / 记忆 |

实现侧用字符近似时：默认按 **1 token ≈ 1.2 汉字** 换算，并在契约常量里写明。

## 3. 摘要 schema（结构化，优于散文）

### 3.1 进房前情提要 `SessionToRoomBrief`

- `goal`：当前目标  
- `decisions`：已确认结论（列表）  
- `openQuestions`：未决问题  
- `todos`：待办  
- `artifacts`：关键路径 / 文件 / 约束  
- `sourceSessionId`：指针  
- `tokenEstimate` / `charCount`：预算审计  

### 3.2 回写摘要 `RoomToSessionHandoff`

- `outcomes`：协作结论 / 交付物  
- `changes`：改了什么（文件 / 任务状态）  
- `risks`：未完成与风险  
- `roomId`：细节可查指针  
- `tokenEstimate` / `charCount`

## 4. 安全与非目标

- 原 session 私有内容不因入房自动公开给非协调者；按需读取经工具 + 权限。  
- 精炼用便宜/快速模型，不占主对话窗口硬塞。  
- **非目标（本规格不要求）**：单会话运行时降级为 room 投影；Sidecar 充当多 Bot 协作；静默升级/回退。

## 5. 落地切片

1. **契约层** ✅（2026-08-23，`9a8aa3a`）：类型、预算常量、裁剪/校验纯函数、单测。见 §85。
2. **服务层** ✅（2026-08-23）：summarize 调用、`enter/exit/excerpt` IPC（`userConfirmed` 闸）、写 room 背景 / 写回 session；fail-closed 启发式 + 单测。brief：`P2-UX-BRIDGE-SERVICE-brief.md`。见 §86。
   - **已做**：明示进房（精炼前情提要写房间 goal + 系统消息）/ 明示退出（精炼结论写回原 session 面板 + 清 `fusionRoomId` + 房间 `paused`）/ 按需读原史（预算校验 + 读 panel + clamp，IPC 已暴露）。
   - **Completed 2026-08-24**: local room-service host-tool wiring for read_source_session_excerpt is coordinator-only; source identity comes from the room and the existing budget validator remains authoritative. Remote FusionRoom authority was not changed because it has no source-session truth field.
3. **UI 层** ✅（2026-08-24）：`SessionBotBar` 开启协作确认（`DestructiveConfirmDialog` → `enterCollaborationWithBridge({ userConfirmed:true })` + 派发 `tagent:session-meta-changed` + toast.success）+ 关掉旧静默 `upgradeFusionSessionToRoom`（旧路径从此 UI 断开，IPC 仍保留）；`CollaborationRoomsPage` 头部「结束协作」确认（`room.sourceSessionId` 匹配当前会话时显示，与归档区分）→ `exitCollaborationWithBridge` + `session-meta-changed` + `onCollaborationExited` + toast；协作期原会话入口已由 Chat 据 `fusionRoomId` 切壳隐藏（避免双入口）。失败抛错由确认框内联提示。`SessionBotBar.test.tsx` 3 pass。brief：`P2-UX-BRIDGE-UI-brief.md`。**未做（留后）**：host 工具接线（协调者按需读原史的工具回路，`readCollaborationSourceExcerpt` IPC 已暴露）；成员减到 1 的可选 toast 提示（不自动 exit）。见 §87。
