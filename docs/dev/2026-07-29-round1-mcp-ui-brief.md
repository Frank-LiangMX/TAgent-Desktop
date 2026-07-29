# [dev] Round 1 Brief — MCP 配置 UI + 真实连接测试

> 主线总监 brief。开发代理（kscc / glm-5.2）按此执行。
> 范围：只做 MCP 管理闭环。不要顺手做子代理 / 记忆 / 错误恢复。

## 目标

让用户能在设置里按**工作区**管理 MCP：列表 / 增删改 / 启用开关 / 真实连接测试。  
后端 store + IPC 已有，agent 循环已注入 enabled MCP；缺 UI 与真实 TEST。

## 现状（已有）

| 层 | 文件 | 状态 |
|----|------|------|
| 类型 | `packages/shared/src/types/agent.ts` `McpServerEntry` / `WorkspaceMcpConfig` | 完整 |
| 存储 | `apps/electron/src/main/lib/mcp/mcp-store.ts` | CRUD + getEnabled 完成 |
| IPC | `apps/electron/src/main/lib/ipc/mcp-service.ts` | GET/SAVE/upsert/delete 完成；**TEST 占位** |
| preload | `apps/electron/src/preload/index.ts` | 仅 get/save；缺 upsert/delete/test |
| 桥 | `packages/pi-core/src/mcp-bridge.ts` | stdio/http/sse 真实连接 + listTools |
| UI | 无 MCP 设置页 | **待做** |
| 设置壳 | `SettingsPage.tsx` | channels/workspace/… 可加 `mcp` tab |

## 必须交付

### 1. 真实 MCP 连接测试（main）

在 `mcp-service.ts` 的 `TEST_MCP_SERVER` 中实现真实探测：

- 复用 `@tagent/pi-core` 的 `buildMcpToolsForServer` **或** 同包连接逻辑（优先导出一个轻量 `testMcpServer(name, entry)`，成功返回 tool 数量）
- stdio：能 spawn + listTools
- http / sse：能 connect + listTools
- 失败：返回 `{ success: false, message: 可读错误 }`
- 超时：尊重 `entry.timeout`（秒），默认 30
- 测试成功/失败可写回 entry 的 `lastTestResult`（可选但推荐：upsert 时由 UI 或 test handler 持久化）

### 2. preload + App 类型补齐

`window.electronAPI` 增加：

- `upsertMcpServer(slug, name, entry)`
- `deleteMcpServer(slug, name)`
- `testMcpServer(entry)` → `{ success, message }`  
  （若 test 需要 slug 以便写 lastTestResult：`testMcpServer(slug, name, entry)` 也可以）

`App.tsx` Window 类型同步。

### 3. 设置 UI：MCP 页

新建例如：

- `apps/electron/src/renderer/components/settings/McpSettings.tsx`
- 可选 model 纯函数：`mcp-settings-model.ts`（校验 / draft，对齐 ChannelsSettings 风格）

行为：

1. **先选工作区**（`workspacesAtom`；无工作区提示先打开项目）
2. slug：用 workspace 的 `id`（即 projects/{id}/mcp.json 的 sanitizedPath；确认与 `getProjectDir` / listWorkspaces 一致）
3. 列表：名称、type、enabled Switch、command/url 摘要、lastTestResult
4. 添加 / 编辑表单：
   - name（编辑时不可改名，或支持 rename=delete+upsert）
   - type: stdio | http | sse
   - stdio: command, args（空格或 JSON 数组），env（可选 key=value 多行）
   - http/sse: url, headers（可选）
   - timeout（秒，可选）
   - enabled
5. 操作：保存、删除（确认）、测试连接、启用开关即时 upsert
6. 视觉：复用 ChannelsSettings / SettingsCard / Button / Switch / DestructiveConfirmDialog 等 `@tagent/ui` 组件；设置 shell 已有 styles

### 4. Settings 接入

- `SettingsTab` 增加 `'mcp'`
- ALL_TABS 加「MCP」项（建议 core 组，图标可用 `Plugs` / `Server`）
- `renderTabContent` 挂 `McpSettings`
- 宽内容可像 channels 一样加 `settings-shell-content--wide`

### 5. 测试

至少：

- unit：`mcp-settings-model` 校验（name 必填、stdio 要 command、http/sse 要 url）
- unit 或轻测：test 结果形状 / store upsert（若方便 mock）
- `bun run typecheck` + 相关 vitest 通过

## 约束

- 中文 commit message 由总监写；你**不要** git push（总监 checkpoint）
- 不要改无关大重构
- 不要提交 `node_modules` / dist / out
- 保持 typecheck 绿

## 完成定义（DoD）

- [ ] 设置里能看到 MCP tab
- [ ] 能按工作区 CRUD + 启用
- [ ] 测试连接对 stdio/http/sse 非占位
- [ ] typecheck 通过
- [ ] 有最小单测

## 参考风格

- `ChannelsSettings.tsx` + `channel-settings-model.ts`
- `mcp-store.ts` / `mcp-service.ts`
- `packages/pi-core/src/mcp-bridge.ts`
