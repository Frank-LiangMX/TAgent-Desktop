# [dev] Round 3 Brief — 插件整包市场（P0）

> 主线总监 brief。开发代理（kscc / glm-5.2）执行。
> **产品单位 = 整合包 Bundle**（Cursor/Codex/TAgent_General 风格），不是零散 MCP 行。

## 定调

- 用户主路径：浏览整包 → 一键安装 → 已装列表管理
- MCP 原始 CRUD（设置里现有 MCP 页）降为 **高级自定义**
- 数据模型已在 `@tagent/shared`：
  - `StorePluginBundle` / `TAGENT_STORE_PLUGIN_BUNDLES`
  - `buildPluginStoreCatalog()` / `InstallStoreBundleResult`
  - `WorkspacePluginBundleRecord` / `plugins-installed.json`
  - IPC 名：`GET_PLUGIN_STORE_CATALOG` / `INSTALL_STORE_BUNDLE` / `INSTALL_STORE_SKILL`
- 参考实现：`F:/TAgent_General/apps/electron/src/main/lib/agent-workspace-manager.ts` 的 installStore*（**逻辑可精简移植，UI 干净重写，不搬屎山**）

## 范围（MVP 必做）

### 1. 主进程：plugin-store 服务

新建例如：

- `apps/electron/src/main/lib/plugin/plugin-store.ts`
- `apps/electron/src/main/lib/ipc/plugin-service.ts`

能力：

| API | 行为 |
|-----|------|
| `getPluginStoreCatalog()` | 调 `buildPluginStoreCatalog()` |
| `getInstalledPlugins(slug)` | 读 `projects/{slug}/plugins-installed.json` |
| `installStoreBundle(slug, bundleId)` | 装包内 MCP + 可装 Skill + 写 manifest |
| `uninstallStoreBundle(slug, bundleId)` | 删 manifest；移除该包记录的 MCP（仅当仍是商店安装形态可删）；Skill 目录若存在则删 |
| `installStoreMcp(slug, mcpName)` | 可选：单条 MCP 安装（市场次要入口） |

MCP 安装：用 `mcpCatalogEntryToServerEntry` + **enabled: true** 写入现有 `mcp-store`（已存在则 skip）。

Skill 安装（最小可用）：

- `installKind === 'inline'`：写入 `projects/{slug}/skills/{skillSlug}/SKILL.md`（frontmatter + body）
- `installKind === 'bundled'`：若本仓库尚无 bundled 资源目录，**记入 errors 并 skip**，不要假成功
- 工作区 skills 根：`getProjectDir(slug)/skills/`

卸载：

- 从 manifest 去掉 bundle
- 删除该 bundle 记录的 mcp 名（仅当 mcp.json 条目仍匹配商店 command/args 时可删，避免误删用户改过的自定义）
- 删除该 bundle 记录的 skill 目录（存在则 rm）

### 2. preload + App 类型

暴露：

- `getPluginStoreCatalog()`
- `getInstalledPluginBundles(slug)`
- `installStoreBundle(slug, bundleId)`
- `uninstallStoreBundle(slug, bundleId)`

在 `main/index.ts` 创建 PluginService。

### 3. UI：设置 →「插件」为主

- `SettingsTab` 增加 `'plugins'`（core 组，优先于 MCP）
- 新组件：`PluginStoreSettings.tsx`（或 `plugins/` 目录）
  - 顶部：工作区选择（与 McpSettings 同）
  - Segmented：**市场** | **已安装**
  - **市场**：默认展示 **整合包卡片网格**（name/description/category/含 N MCP + M Skill/安装按钮）
  - 点卡片可展开详情（包内 MCP/Skill 列表）
  - **已安装**：来自 plugins-installed.json，卸载按钮
- 现有 `mcp` tab 标签改为 **「高级 MCP」** 或 description 标明「自定义服务器」

视觉：复用设置页 + ChannelsSettings 卡片节奏；不必 1:1 抄 General spatial 皮肤。

### 4. 测试

- `plugin-store.test.ts`：install bundle 写 mcp + manifest；重复安装 skip；uninstall 清 manifest
- 用 `TAGENT_CONFIG_DIR` 临时目录
- typecheck + vitest 绿

## 明确不做（本轮）

- 完整 Skill 编辑器 / skill 启用切换 UI
- 从 GitHub 远程拉 skill bundle 资源
- 角色商店 / TA 一键装
- 搬 General 的 PluginMarketplace 巨型组件树

## DoD

- [ ] 设置里有「插件」入口，默认看整包
- [ ] 选工作区后可安装 catalog 中某个 bundle（至少 MCP 部分生效）
- [ ] plugins-installed.json 正确落盘
- [ ] 已安装列表可卸载
- [ ] 高级 MCP 页仍可用
- [ ] typecheck + 单测通过

## 约束

- 不要 git commit/push
- 中文 UI
- 最小可用优先
