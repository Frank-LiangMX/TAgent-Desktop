import { ipcMain } from "electron";

import {
  BOT_IPC_CHANNELS,
  type BotSidecarBridgeRequest,
  type EnsureBotSidecarSessionInput,
  type CloseBotSidecarInput,
  type ConsolidateBotMemoryInput,
  type CreateBotProfileInput,
  type OpenBotSidecarInput,
  type PublishBotConfigRevisionInput,
  type SaveBotMemoryCandidateInput,
  type SaveBotProfileInput,
} from "@tagent/shared";

import {
  archiveBotProfile,
  createBotProfile,
  getBotProfileRecord,
  loadBotProfiles,
  publishBotConfigRevision,
  saveBotProfileRecord,
} from "./bot-profile-service";
import {
  activateBotMemory,
  consolidateBotMemoryWithAi,
  archiveBotMemory,
  loadBotMemories,
  rejectBotMemory,
  saveBotMemoryCandidate,
} from "./bot-memory-service";
import {
  bridgeBotSidecarRequest,
  ensureBotSidecarSession,
  closeBotSidecar,
  minimizeBotSidecar,
  openBotSidecar,
} from "./bot-sidecar-service";

/** Bot 库 IPC；所有持久化仍由主进程服务完成，renderer 不直接读写 bots.json。 */
export function registerBotIpcHandlers(): void {
  ipcMain.handle(BOT_IPC_CHANNELS.LIST, async () => loadBotProfiles());

  ipcMain.handle(BOT_IPC_CHANNELS.GET, async (_event, profileId: string) =>
    getBotProfileRecord(profileId),
  );

  ipcMain.handle(
    BOT_IPC_CHANNELS.SAVE,
    async (_event, input: SaveBotProfileInput) => {
      if (!input?.record) throw new Error("missing bot record");
      return saveBotProfileRecord(input.record);
    },
  );

  ipcMain.handle(
    BOT_IPC_CHANNELS.CREATE,
    async (_event, input: CreateBotProfileInput) => {
      if (!input?.record) throw new Error("missing bot record");
      if (input.record.revisions.length !== 1)
        throw new Error("create Bot 只能绑定一个首个 revision");
      return createBotProfile(input.record.profile, input.record.revisions[0]!);
    },
  );

  ipcMain.handle(BOT_IPC_CHANNELS.ARCHIVE, async (_event, profileId: string) =>
    archiveBotProfile(profileId),
  );

  ipcMain.handle(
    BOT_IPC_CHANNELS.PUBLISH_REVISION,
    async (_event, input: PublishBotConfigRevisionInput) => {
      if (!input?.profileId || !input.revision)
        throw new Error("missing revision input");
      return publishBotConfigRevision(input.profileId, input.revision);
    },
  );

  ipcMain.handle(
    BOT_IPC_CHANNELS.MEMORY_LIST,
    async (_event, profileId: string) => loadBotMemories(profileId),
  );

  ipcMain.handle(
    BOT_IPC_CHANNELS.MEMORY_SAVE_CANDIDATE,
    async (_event, input: SaveBotMemoryCandidateInput) => {
      if (!input?.memory) throw new Error("missing memory");
      return saveBotMemoryCandidate(input.memory);
    },
  );

  ipcMain.handle(
    BOT_IPC_CHANNELS.MEMORY_CONSOLIDATE,
    async (_event, input: ConsolidateBotMemoryInput) => {
      if (!input?.botProfileId || !input?.ownerUserId) {
        throw new Error("missing bot memory consolidation identity");
      }
      const bot = getBotProfileRecord(input.botProfileId);
      if (!bot || bot.profile.status === "archived") {
        throw new Error("Bot 不存在或已归档");
      }
      if (bot.profile.ownerUserId !== input.ownerUserId) {
        throw new Error("只能整理 Bot 所有者提交的记忆");
      }
      return consolidateBotMemoryWithAi(input);
    },
  );
  ipcMain.handle(
    BOT_IPC_CHANNELS.MEMORY_ACTIVATE,
    async (_event, memoryId: string) => activateBotMemory(memoryId),
  );

  ipcMain.handle(
    BOT_IPC_CHANNELS.MEMORY_REJECT,
    async (_event, memoryId: string) => rejectBotMemory(memoryId),
  );

  ipcMain.handle(
    BOT_IPC_CHANNELS.MEMORY_ARCHIVE,
    async (_event, memoryId: string) => archiveBotMemory(memoryId),
  );

  ipcMain.handle(
    BOT_IPC_CHANNELS.SIDECAR_OPEN,
    async (_event, input: OpenBotSidecarInput) => openBotSidecar(input),
  );

  ipcMain.handle(
    BOT_IPC_CHANNELS.SIDECAR_SESSION_ENSURE,
    async (_event, input: EnsureBotSidecarSessionInput) =>
      ensureBotSidecarSession(input),
  );
  ipcMain.handle(
    BOT_IPC_CHANNELS.SIDECAR_CLOSE,
    async (_event, input: CloseBotSidecarInput) => closeBotSidecar(input),
  );
  ipcMain.handle(
    BOT_IPC_CHANNELS.SIDECAR_MINIMIZE,
    async (_event, sidecarId: string) => minimizeBotSidecar(sidecarId),
  );
  ipcMain.handle(
    BOT_IPC_CHANNELS.SIDECAR_BRIDGE_REQUEST,
    async (_event, input: BotSidecarBridgeRequest) =>
      bridgeBotSidecarRequest(input),
  );

  console.log("[bot] IPC 已注册");
}
