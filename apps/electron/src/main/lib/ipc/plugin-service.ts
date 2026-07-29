/**
 * 插件商店服务：注册 plugin-store IPC handler
 *
 * 用 @tagent/shared AGENT_IPC_CHANNELS 中已定义的插件商店通道名。
 * 职责：读商店目录 / 读已安装记录 / 安装整合包 / 卸载整合包。
 * 逻辑全部在 lib/plugin/plugin-store，此处仅做 IPC 转发（与 mcp-service 同风格）。
 */
import { ipcMain } from 'electron'
import {
  AGENT_IPC_CHANNELS,
  type PluginStoreCatalog,
  type InstallStoreBundleResult,
  type WorkspacePluginBundleRecord,
} from '@tagent/shared'
import {
  getPluginStoreCatalog,
  getInstalledPluginBundles,
  installStoreBundle,
  uninstallStoreBundle,
  type UninstallStoreBundleResult,
} from '../plugin/plugin-store'

export class PluginService {
  private constructor() {}

  static create(): PluginService {
    const svc = new PluginService()
    svc.registerIpc()
    return svc
  }

  private registerIpc(): void {
    // 获取插件商店目录（整合包 + Skill + MCP）
    ipcMain.handle(
      AGENT_IPC_CHANNELS.GET_PLUGIN_STORE_CATALOG,
      async (): Promise<PluginStoreCatalog> => {
        return getPluginStoreCatalog()
      }
    )

    // 获取工作区已安装整合包记录（plugins-installed.json）
    ipcMain.handle(
      AGENT_IPC_CHANNELS.GET_INSTALLED_PLUGIN_BUNDLES,
      async (_e, slug: string): Promise<WorkspacePluginBundleRecord[]> => {
        return getInstalledPluginBundles(slug)
      }
    )

    // 安装整合包（写 MCP + 可装 Skill + 写 manifest）
    ipcMain.handle(
      AGENT_IPC_CHANNELS.INSTALL_STORE_BUNDLE,
      async (
        _e,
        args: { slug: string; bundleId: string }
      ): Promise<InstallStoreBundleResult> => {
        return installStoreBundle(args.slug, args.bundleId)
      }
    )

    // 卸载整合包（移除 manifest 记录 + 仍匹配商店形态的 MCP + 记录的 Skill 目录）
    ipcMain.handle(
      AGENT_IPC_CHANNELS.UNINSTALL_STORE_BUNDLE,
      async (
        _e,
        args: { slug: string; bundleId: string }
      ): Promise<UninstallStoreBundleResult> => {
        return uninstallStoreBundle(args.slug, args.bundleId)
      }
    )
  }
}
