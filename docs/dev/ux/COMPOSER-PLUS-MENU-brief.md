# Composer「+」菜单：附件 + 知识库收拢

## 目标

对齐 Cursor 输入框「+」菜单：

1. **隐藏**输入栏底栏里强制常驻的「知识库」按钮（`KnowledgeBaseSelector` 触发器）。
2. 「+」不再直接打开文件对话框，改为弹出菜单。
3. 菜单项至少包含：
   - **图片 / 文件**（原添加附件，点选后关菜单并打开文件对话框）
   - **知识库**（带 `>` 子菜单；内容复用现有绑定/模式面板）

## 改动范围

| 文件 | 动作 |
|------|------|
| `apps/electron/src/renderer/components/chat/ComposerPlusMenu.tsx` | **新建**：+ 触发器 + 菜单（Popover 或 DropdownMenu） |
| `apps/electron/src/renderer/components/knowledge-base/KnowledgeBaseSelector.tsx` | 抽出可复用的面板内容（如 `KnowledgeBasePanel`），触发器可删或仅内部用 |
| `apps/electron/src/renderer/components/chat/Chat.tsx` | 会话底栏与 landingFooter：去掉常驻 KB；用 `ComposerPlusMenu` 替换裸 + 按钮 |

## UI 契约

- 触发器：保持现有 `icon-sm` ghost 圆形 `Plus`，`aria-label` 改为「添加」或「添加附件与知识库」。
- 主菜单：上→下：图片/文件 → 知识库（右侧 Chevron）。
- 知识库子面板：宽度约 `w-80`，交互与现 `KnowledgeBaseSelector` PopoverContent **一致**（列表多选、使用方式、管理知识库）。
- 勾选知识库 / 切模式时**不要**因点击而关掉整棵菜单（`onSelect` preventDefault 或 Popover 受控态）。
- 已绑定且 mode≠off 时，可用 primary 色轻微强调「+」或「知识库」行；**不要**再在底栏右侧塞回完整 KB 芯片。
- landing（新会话）底栏：同样去掉常驻 KB；左侧补上同一套 `ComposerPlusMenu`（草稿会话无 session meta 写失败风险——`onDraftWorkspaceChange` 存在时知识库项可隐藏，与现逻辑 `!onDraftWorkspaceChange` 一致）。

## 技术偏好

- 优先复用 `@tagent/ui`：`Popover` + `MenuPopoverItem` / `MenuPopoverSeparator`，或 `DropdownMenu` + `DropdownMenuSub*`。
- 子菜单侧滑与 Cursor 更接近时用 DropdownMenu Sub；两级同 Popover（点知识库切面板 + 返回）也可。
- 不要改 KB IPC / meta 契约；只动渲染层入口。

## 验收

1. 会话输入栏右侧**不再**出现「知识库」按钮。
2. 点「+」出菜单；选「图片/文件」→ 系统文件对话框，选完仍进 pendingAttachments。
3. 选「知识库」→ 可绑定/改 mode/开管理页，行为与改前一致。
4. 新会话 landing：无常驻 KB；非草稿时 + 菜单含知识库。
5. 拖拽/粘贴附件仍可用（不回归）。

## 本轮不做

- Plan/Debug/Ask 等模式项
- Models / MCP 收进 + 菜单
- 搜索框「Add agents, context…」
- 后端 KB 逻辑变更
