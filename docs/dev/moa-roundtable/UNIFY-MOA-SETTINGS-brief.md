# Brief：设置「会诊 + 圆桌」合并为单一「MOA」页

## 目标

侧栏 **Agent 行为** 下：

- **删除**独立「会诊」「圆桌」两项
- **新增/改名**一项：**MOA**（tab id 仍用 `agent-roundtable`，兼容旧深链）
- **同一套配置**：现有 MoA 预置 CRUD（模型/座位/汇总）供会诊与圆桌共用
- 圆桌专属偏好（轮次上限、`@` 深度、composer 路由）并入本页下一节，不再单独成页

## 改动范围

1. `SettingsPage.tsx`
   - `ALL_TABS`：去掉 `agent-discuss`；`agent-roundtable` 的 label → `MOA`，description → 覆盖会诊+圆桌
   - `normalizeSettingsTab`：`agent-discuss` / `agent` → `agent-roundtable`
   - `renderTabContent`：`agent-roundtable` 渲染合并页；`agent-discuss` case 归一即可
   - wide pane：MOA 页保持 wide

2. 新建或改 `MoaSettings.tsx`（推荐薄封装）：
   - Intro：标题 MOA；说明会诊（并行交卷）与圆桌（互相对话）共用下方班底
   - 上：现有 `AgentBehaviorSettings` 主体（可抽掉其独立 Intro，或让它接受 `hideIntro`）
   - 下：原 `AgentDiscussSettings` 的表单区（无独立全页 intro；小节标题如「圆桌运行偏好」）

3. 文案：`AgentBehaviorSettings` 内「会诊」→ 可改为「MOA 班底 / 预置」，避免只提会诊；发送旁入口文案可暂不动（另议）

4. **不做**：改 runtime 协议、合并 prefs 文件、改班组页、删 discuss prefs IPC

## 验收

- [ ] 设置侧栏 Agent 行为只有：MOA / 子代理 / 班组（无单独会诊、圆桌）
- [ ] 打开旧 `agent-discuss` / `agent` 深链落到 MOA
- [ ] MOA 页可 CRUD 预置；圆桌三项偏好可读写落盘
- [ ] 现有 prefs / moa IPC 单测仍过
