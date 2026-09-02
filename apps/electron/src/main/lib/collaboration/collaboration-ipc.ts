/**
 * 协作室 IPC 注册（Stage 3）
 *
 * 注册 COLLABORATION_ROOM_IPC_CHANNELS 的 10 个请求/响应通道：
 * LIST / CREATE / GET / UPDATE / LIST_MESSAGES / APPEND_USER_MESSAGE / LIST_MEMBERS /
 * ADD_MEMBER / LIST_RUNS / CANCEL_RUN。
 *
 * CHANGED 为 main → renderer 广播：run/member/message 变更时 service 调 broadcast，
 * 此处包装成 `getWindow()?.webContents.send(CHANGED, { roomId, kind, at })`（对齐
 * kanban-bootstrap 的广播模式）。渲染层收到后重新拉取该房间数据。
 *
 * 注册时调用 service.recoverInterruptedRuns()：queued 安全恢复，running/awaiting 标为
 * blocked(INTERRUPTED)，进入用户确认续跑流程，避免重启后「假 running」。
 *
 * handler 直接返回 service 结果；service 在校验/非法状态时 throw，
 * ipcMain.handle 会让 invoke 的 Promise reject，渲染层 try/catch 即可。
 *
 * 设计参考：apps/electron/src/main/lib/kanban/kanban-bootstrap.ts（getWindow 广播模式）
 */
import { BrowserWindow, dialog, ipcMain } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import {
  canContinueCollaborationDepthStop,
  COLLABORATION_ROOM_IPC_CHANNELS,
  type AddCollaborationMemberInput,
  type AppendCollaborationUserMessageInput,
  type BoardProjectedSummary,
  type BoardProjectedTask,
  type CancelCollaborationRunInput,
  type RetryCollaborationRunInput,
  type RetryCollaborationRunResult,
  type CollaborationArtifact,
  type CollaborationMailboxEnvelope,
  type CollaborationMember,
  type CollaborationMemberBackendStatus,
  type CollaborationHumanMember,
  type CollaborationMemberPreset,
  type CollaborationMessage,
  type CollaborationMessagesPage,
  type CollaborationRoom,
  type CollaborationRoomTask,
  type CollaborationWorkspaceBindingView,
  type CollaborationRun,
  type CollaborationRunsPage,
  type CollaborationRunSummary,
  type ContinueCollaborationDepthStopInput,
  type ContinueCollaborationDepthStopResult,
  type CreateCollaborationRoomInput,
  type UpgradeFusionSessionInput,
  type SaveCollaborationMemberPresetInput,
  type CreateCollaborationRoomTaskInput,
  type GetBoardProjectedSummaryInput,
  type ListBoardProjectedTasksInput,
  type ListCollaborationArtifactsInput,
  type ListCollaborationMailboxInput,
  type ListCollaborationMembersInput,
  type InviteCollaborationHumanMemberInput,
  type JoinCollaborationHumanMemberInput,
  type LeaveCollaborationHumanMemberInput,
  type RemoveCollaborationHumanMemberInput,
  type SetCollaborationBotOwnerConsentInput,
  type ListCollaborationMessagesInput,
  type ListCollaborationRoomTasksInput,
  type ListCollaborationUserApprovalsInput,
  type ListCollaborationRoomsInput,
  type ListCollaborationRunsInput,
  type ReadCollaborationArtifactInput,
  type ReadCollaborationArtifactResult,
  type DownloadCollaborationArtifactInput,
  type DownloadCollaborationArtifactResult,
  type ImportCollaborationWorkspaceResponse,
  type ResolveCollaborationUserApprovalInput,
  type ResolveCollaborationUserApprovalResult,
  type ListCollaborationContinuationsInput,
  type ListCollaborationContinuationsResult,
  type ConfirmResumeBlockedRunInput,
  type ConfirmResumeBlockedRunResult,
  type UpdateCollaborationMemberInput,
  type RemoveCollaborationMemberInput,
  type UpdateCollaborationRoomInput,
  type UpdateCollaborationRoomTaskInput,
  type EnterCollaborationWithBridgeInput,
  type EnterCollaborationWithBridgeResult,
  type ExitCollaborationWithBridgeInput,
  type ExitCollaborationWithBridgeResult,
  type ReadSourceSessionExcerptInput,
  type ReadSourceSessionExcerptResult,
} from "@tagent/shared";
import { CollaborationRoomService } from "./collaboration-room-service";
import { SessionCollabBridgeService } from "./session-collab-bridge-service";
import {
  deleteCollaborationMemberPreset,
  listCollaborationMemberPresets,
  saveCollaborationMemberPreset,
} from "./collaboration-room-repository";
import { onKanbanTaskStatusChanged } from "../kanban/kanban-bootstrap";
import { getSessionMeta, updateSessionMeta } from "../agent/session-store";
import { getBotProfileRecord } from "../bot/bot-profile-service";
import { setRegisteredCollaborationRoomService } from "./collaboration-runtime";
import { resolveChannelBackendConfig } from "./member-backend-adapter";
import { resolveTaskSubagentBackend } from "../agent/cli-workers/resolve-backend";
import { resolveCodexRuntimeAsync } from "../adapters/codex/codex-runtime-resolver";

/**
 * S4.5 IPC 守卫：委托 service.continueDepthStop 前校验信封属于该房间且仍可继续一次。
 * 纯函数（不读 DB、不触 backend），便于离线单测；envelopes 由 handler 从
 * service.listMailbox(roomId) 传入，确保信封 roomId 与 input.roomId 一致，防跨房间继续。
 */
export function resolveCollaborationDepthStopContinue(
  envelopes: CollaborationMailboxEnvelope[],
  input: ContinueCollaborationDepthStopInput,
):
  | { ok: true; envelope: CollaborationMailboxEnvelope }
  | { ok: false; reason: string } {
  const envelope = envelopes.find(
    (e) => e.id === input.envelopeId && e.roomId === input.roomId,
  );
  if (!envelope) {
    return { ok: false, reason: "深度停止信封不存在或不属于该房间" };
  }
  if (!canContinueCollaborationDepthStop(envelope)) {
    return { ok: false, reason: "该深度停止不可继续或已使用过继续机会" };
  }
  return { ok: true, envelope };
}

/** 按成员实际运行路径解析后端可用性；不把凭据或本机路径返回 renderer。 */
export async function getCollaborationMemberBackendStatuses(
  service: CollaborationRoomService,
  roomId: string,
): Promise<CollaborationMemberBackendStatus[]> {
  const room = service.getRoomById(roomId);
  if (!room) throw new Error("房间不存在");
  const members = service.listMembers(roomId);
  const needsCodex = members.some(
    (member) => member.status !== "removed" && member.backend === "codex",
  );
  const codexStatus = needsCodex ? await resolveCodexRuntimeAsync() : null;

  return Promise.all(
    members.map(async (member) => {
      if (member.status === "removed") {
        return { memberId: member.id, available: false, reason: "成员已移除" };
      }
      try {
        if (member.backend === "codex") {
          return codexStatus?.available
            ? { memberId: member.id, available: true }
            : {
                memberId: member.id,
                available: false,
                reason: "未检测到可用的 Codex Runtime",
              };
        }
        if (member.backend === "cli") {
          const resolved = resolveTaskSubagentBackend({
            preferredCliId: member.cliWorkerId,
          });
          return resolved.kind === "cli"
            ? { memberId: member.id, available: true }
            : {
                memberId: member.id,
                available: false,
                reason: "指定的 CLI worker 未启用或本机不可用",
              };
        }
        resolveChannelBackendConfig({
          channelId: member.channelId,
          modelId: member.modelId,
        });
        return { memberId: member.id, available: true };
      } catch (error) {
        return {
          memberId: member.id,
          available: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

/**
 * 协作室成员变化后的源会话投影。
 *
 * 房间是升级后的唯一运行真值；源会话只保留可恢复的参与者快照。成员低于两个时，
 * 源会话退出 multi-bot 路由并清掉房间入口，历史房间仍可从协作室列表打开。
 */
export function syncSourceSessionAfterRoomMemberChange(
  service: CollaborationRoomService,
  roomId: string,
): void {
  const room = service.getRoomById(roomId);
  const sourceSessionId = room?.sourceSessionId;
  if (!sourceSessionId) return;

  // sourceSessionId 只是历史归属，不等于当前仍在协作室。用户退出协作室后，
  // bridge 会清掉 meta.fusionRoomId；此时成员变更或应用重启都不能把它静默绑回去。
  const sourceMeta = getSessionMeta(sourceSessionId);
  if (sourceMeta?.fusionRoomId !== roomId) return;

  const activeMembers = service
    .listMembers(roomId)
    .filter((member) => member.status !== "removed");
  const botProfileIds = activeMembers
    .map((member) => member.botProfileId)
    .filter((id): id is string => Boolean(id));
  const activeMemberCount = activeMembers.length;
  const coordinatorBotProfileId = activeMembers.find(
    (member) => member.isCoordinator && member.botProfileId,
  )?.botProfileId;

  // 来源会话的 botProfileIds 只能表达 Bot 身份，不能拿它代替房间成员总数。
  // 手动 Codex/CLI/外部成员没有 botProfileId；只要房间仍有至少两名活跃成员，
  // 就必须保留当前 fusionRoomId，否则移除一个 Bot 会误把仍在运行的房间拆掉。
  if (activeMemberCount >= 2) {
    updateSessionMeta(sourceSessionId, {
      botProfileIds,
      fusionMode: "multi-bot",
      fusionCoordinatorBotProfileId:
        coordinatorBotProfileId ?? botProfileIds[0],
      fusionRoomId: room.id,
    });
    return;
  }
  if (botProfileIds.length === 1) {
    updateSessionMeta(sourceSessionId, {
      botProfileIds,
      fusionMode: "single-bot",
      fusionCoordinatorBotProfileId: undefined,
      fusionRoomId: undefined,
    });
    return;
  }
  updateSessionMeta(sourceSessionId, {
    botProfileIds: [],
    fusionMode: "ordinary",
    fusionCoordinatorBotProfileId: undefined,
    fusionRoomId: undefined,
  });
}

/**
 * 应用启动后的来源会话恢复。
 *
 * 房间与来源会话分属两个持久化仓库，成员变更期间如果应用被关闭，不能假设
 * 两边最后一次写入同时完成。因此启动时以房间成员快照为真值重新投影一次；
 * 来源会话不存在时 updateSessionMeta 会安全返回 undefined，不阻断其它房间恢复。
 */
export function reconcileLinkedSourceSessions(
  service: CollaborationRoomService,
): number {
  let reconciled = 0;
  for (const room of service.listRooms(true)) {
    if (!room.sourceSessionId) continue;
    // 只修复“两边都明确指向同一房间”的投影，不从历史 room 反向制造新链接。
    const sourceMeta = getSessionMeta(room.sourceSessionId);
    if (sourceMeta?.fusionRoomId !== room.id) continue;
    syncSourceSessionAfterRoomMemberChange(service, room.id);
    reconciled += 1;
  }
  return reconciled;
}

export function registerCollaborationRoomIpc(
  getWindow?: () => BrowserWindow | null,
  notifySessionMetaChanged?: (sessionId: string) => void,
): void {
  const service = CollaborationRoomService.create({
    broadcast: (roomId, kind) => {
      const win = getWindow?.();
      if (!win) return;
      win.webContents.send(COLLABORATION_ROOM_IPC_CHANNELS.CHANGED, {
        roomId,
        kind,
        at: Date.now(),
      });
    },
    onTextDelta: (payload) => {
      const win = getWindow?.();
      if (!win) return;
      win.webContents.send(COLLABORATION_ROOM_IPC_CHANNELS.TEXT_DELTA, payload);
    },
  });
  setRegisteredCollaborationRoomService(service);

  // P2-UX 桥接服务：明示进房 / 明示退出 / 按需读原史（userConfirmed 闸，复用上面的 service）。
  // 进退房后的 meta 变更复用 SessionService 的统一 STREAM_EVENT → Chat → persisted-meta 链路。
  const bridgeService = new SessionCollabBridgeService({
    roomService: service,
    notifySessionMetaChanged,
  });
  service.setSourceSessionExcerptReader((request, alreadyUsedThisTurnTokens) =>
    bridgeService.readSourceSessionExcerpt(request, alreadyUsedThisTurnTokens),
  );

  // 启动恢复：安全恢复 queued；running/awaiting run fail-closed 为 interrupted/blocked
  try {
    service.recoverInterruptedRuns();
  } catch (err) {
    console.error("[协作室] 启动恢复失败:", err);
  }
  try {
    const count = reconcileLinkedSourceSessions(service);
    if (count > 0) {
      console.log("[协作室] 已恢复 " + count + " 个来源会话投影");
    }
  } catch (err) {
    console.error("[协作室] 来源会话投影恢复失败:", err);
  }

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.LIST,
    async (
      _e,
      input?: ListCollaborationRoomsInput,
    ): Promise<CollaborationRoom[]> => {
      return service.listRooms(input?.includeArchived ?? false);
    },
  );

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.CREATE,
    async (
      _e,
      input: CreateCollaborationRoomInput,
    ): Promise<CollaborationRoom> => {
      return service.createRoom(input);
    },
  );

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.UPGRADE_FROM_SESSION,
    async (
      _e,
      input: UpgradeFusionSessionInput,
    ): Promise<CollaborationRoom> => {
      return service.upgradeFusionSession(input);
    },
  );
  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.GET,
    async (
      _e,
      input: { roomId: string },
    ): Promise<CollaborationRoom | null> => {
      return service.getRoomById(input.roomId) ?? null;
    },
  );

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.UPDATE,
    async (
      _e,
      input: UpdateCollaborationRoomInput,
    ): Promise<CollaborationRoom> => {
      return service.updateRoom(input);
    },
  );

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.LIST_MESSAGES,
    async (
      _e,
      input: ListCollaborationMessagesInput,
    ): Promise<CollaborationMessagesPage> => {
      return service.listMessagesPage(input);
    },
  );

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.APPEND_USER_MESSAGE,
    async (
      _e,
      input: AppendCollaborationUserMessageInput,
    ): Promise<CollaborationMessage> => {
      return service.appendUserMessage(input);
    },
  );

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.LIST_MEMBERS,
    async (
      _e,
      input: ListCollaborationMembersInput,
    ): Promise<CollaborationMember[]> => {
      return service.listMembers(input.roomId);
    },
  );
  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.GET_MEMBER_BACKEND_STATUS,
    async (
      _e,
      input: { roomId: string },
    ): Promise<CollaborationMemberBackendStatus[]> =>
      getCollaborationMemberBackendStatuses(service, input.roomId),
  );

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.LIST_HUMAN_MEMBERS,
    async (_e, input: { roomId: string }): Promise<CollaborationHumanMember[]> => {
      return service.listHumanMembers(input.roomId);
    },
  );

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.LIST_WORKSPACE_BINDINGS,
    async (
      _e,
      input: { roomId: string },
    ): Promise<CollaborationWorkspaceBindingView[]> => {
      return service.listWorkspaceBindings(input.roomId);
    },
  );

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.INVITE_HUMAN_MEMBER,
    async (
      _e,
      input: InviteCollaborationHumanMemberInput,
    ): Promise<CollaborationHumanMember> => {
      return service.inviteHumanMember(input);
    },
  );

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.JOIN_HUMAN_MEMBER,
    async (
      _e,
      input: JoinCollaborationHumanMemberInput,
    ): Promise<CollaborationHumanMember> => {
      return service.joinHumanMember(input);
    },
  );

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.LEAVE_HUMAN_MEMBER,
    async (
      _e,
      input: LeaveCollaborationHumanMemberInput,
    ): Promise<CollaborationHumanMember> => {
      return service.leaveHumanMember(input);
    },
  );

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.REMOVE_HUMAN_MEMBER,
    async (
      _e,
      input: RemoveCollaborationHumanMemberInput,
    ): Promise<CollaborationHumanMember> => {
      return service.removeHumanMember(input);
    },
  );

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.SET_BOT_OWNER_CONSENT,
    async (
      _e,
      input: SetCollaborationBotOwnerConsentInput,
    ): Promise<CollaborationMember> => {
      return service.setBotOwnerConsent(input);
    },
  );
  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.ADD_MEMBER,
    async (
      _e,
      input: AddCollaborationMemberInput,
    ): Promise<CollaborationMember> => {
      const member = service.addMember(input.roomId, input);
      syncSourceSessionAfterRoomMemberChange(service, input.roomId);
      return member;
    },
  );

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.UPDATE_MEMBER,
    async (
      _e,
      input: UpdateCollaborationMemberInput,
    ): Promise<CollaborationMember> => {
      return service.updateMember(input);
    },
  );

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.REMOVE_MEMBER,
    async (
      _e,
      input: RemoveCollaborationMemberInput,
    ): Promise<CollaborationMember> => {
      const member = service.removeMember(input);
      syncSourceSessionAfterRoomMemberChange(service, input.roomId);
      return member;
    },
  );

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.LIST_RUNS,
    async (
      _e,
      input: ListCollaborationRunsInput,
    ): Promise<CollaborationRunsPage> => {
      return service.listRunsPage(input);
    },
  );

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.GET_RUN_SUMMARY,
    async (
      _e,
      input: { roomId: string },
    ): Promise<CollaborationRunSummary> => service.getRunSummary(input.roomId),
  );

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.CANCEL_ALL_RUNS,
    async (
      _e,
      input: { roomId: string },
    ): Promise<{ cancelled: number }> => ({
      cancelled: service.cancelAllRuns(input.roomId),
    }),
  );

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.CANCEL_RUN,
    async (
      _e,
      input: CancelCollaborationRunInput,
    ): Promise<CollaborationRun | null> => {
      // 校验 roomId 与 run 归属一致（防止跨房间取消）
      const run = service.getRunById(input.runId);
      if (!run || run.roomId !== input.roomId) return null;
      return service.cancelRun(input.runId) ?? null;
    },
  );

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.RETRY_RUN,
    async (
      _e,
      input: RetryCollaborationRunInput,
    ): Promise<RetryCollaborationRunResult> => service.retryRun(input),
  );

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.LIST_MAILBOX,
    async (
      _e,
      input: ListCollaborationMailboxInput,
    ): Promise<CollaborationMailboxEnvelope[]> => {
      return service.listMailbox(input.roomId);
    },
  );

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.CONTINUE_DEPTH_STOP,
    async (
      _e,
      input: ContinueCollaborationDepthStopInput,
    ): Promise<ContinueCollaborationDepthStopResult> => {
      // 先做 IPC 侧跨房间守卫（service.continueDepthStop 按 envelopeId 全局取信封，
      // 不带 roomId），再委托 service 执行继续。失败返回 { ok: false, reason }，不抛错。
      const resolved = resolveCollaborationDepthStopContinue(
        service.listMailbox(input.roomId),
        input,
      );
      if (!resolved.ok) return { ok: false, reason: resolved.reason };
      return service.continueDepthStop(resolved.envelope.id, input.idempotencyKey);
    },
  );

  // ===== S5 室级任务/产物面板：复用 service 既有真值层与守卫 =====
  // 任务 create/update 的挂板 fail-closed、负责人归属、严格状态机、CAS 全在 service 内；
  // handler 仅做薄转发，错误以 throw 传递（与 create/update room 一致，渲染层 try/catch）。
  // READ_ARTIFACT 的跨房间校验在 service.readArtifact 内（按 artifactId 反查记录 + 安全区间解析）。

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.LIST_ROOM_TASKS,
    async (
      _e,
      input: ListCollaborationRoomTasksInput,
    ): Promise<CollaborationRoomTask[]> => {
      return service.listRoomTasks(input.roomId);
    },
  );

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.CREATE_ROOM_TASK,
    async (
      _e,
      input: CreateCollaborationRoomTaskInput,
    ): Promise<CollaborationRoomTask> => {
      return service.createRoomTask(input);
    },
  );

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.UPDATE_ROOM_TASK,
    async (
      _e,
      input: UpdateCollaborationRoomTaskInput,
    ): Promise<CollaborationRoomTask> => {
      return service.updateRoomTask(input);
    },
  );

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.LIST_ARTIFACTS,
    async (
      _e,
      input: ListCollaborationArtifactsInput,
    ): Promise<CollaborationArtifact[]> => {
      return service.listArtifacts(input.roomId);
    },
  );

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.READ_ARTIFACT,
    async (
      _e,
      input: ReadCollaborationArtifactInput,
    ): Promise<ReadCollaborationArtifactResult> => {
      return service.readArtifact(input);
    },
  );


  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.IMPORT_WORKSPACE,
    async (
      _e,
      input: { roomId: string; actorUserId?: string },
    ): Promise<ImportCollaborationWorkspaceResponse> => {
      const win = getWindow?.();
      const options = {
        title: "导入个人工作区到协作室",
        properties: ["openDirectory"] as ["openDirectory"],
      };
      const selected = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
      if (selected.canceled || !selected.filePaths[0]) {
        return { ok: false, reason: "已取消导入" };
      }
      return service.importWorkspaceDirectory({
        roomId: input.roomId,
        actorUserId: input.actorUserId,
        sourceDirectory: selected.filePaths[0],
      });
    },
  );
  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.DOWNLOAD_ARTIFACT,
    async (
      _e,
      input: DownloadCollaborationArtifactInput,
    ): Promise<DownloadCollaborationArtifactResult> => {
      const resolved = service.getArtifactDownloadPath(input);
      if (!resolved.ok) return resolved;
      const saveOptions = {
        title: "下载协作室产物",
        defaultPath: basename(resolved.relativePath),
      };
      const win = getWindow?.();
      const save = win
        ? await dialog.showSaveDialog(win, saveOptions)
        : await dialog.showSaveDialog(saveOptions);
      if (save.canceled || !save.filePath) {
        return { ok: true, canceled: true, relativePath: resolved.relativePath };
      }
      try {
        writeFileSync(save.filePath, readFileSync(resolved.absPath));
        return { ok: true, path: save.filePath, relativePath: resolved.relativePath };
      } catch (error) {
        console.error("[协作室] 下载产物失败:", error);
        return { ok: false, reason: "无法写入用户选择的目标文件" };
      }
    },
  );  // ===== S5 看板桥：把挂载看板的只读投影暴露给房间（不反向覆盖真值） =====
  // 房间未挂载 / 看板不存在时 projectBoard* 返回空/fail-open 只读；写操作仍由既有
  // 挂板 fail-closed（createRoomTask / roomTaskUpdate）拒绝。

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.LIST_BOARD_TASKS,
    async (
      _e,
      input: ListBoardProjectedTasksInput,
    ): Promise<BoardProjectedTask[]> => {
      return service.projectBoardTasks(input.roomId);
    },
  );

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.GET_BOARD_SUMMARY,
    async (
      _e,
      input: GetBoardProjectedSummaryInput,
    ): Promise<BoardProjectedSummary | null> => {
      return service.projectBoardSummary(input.roomId);
    },
  );

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.LIST_MEMBER_PRESETS,
    async (): Promise<CollaborationMemberPreset[]> =>
      listCollaborationMemberPresets(),
  );

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.SAVE_MEMBER_PRESET,
    async (
      _e,
      input: SaveCollaborationMemberPresetInput,
    ): Promise<CollaborationMemberPreset> =>
      saveCollaborationMemberPreset(input),
  );

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.DELETE_MEMBER_PRESET,
    async (_e, input: { id: string }): Promise<{ ok: boolean }> => ({
      ok: deleteCollaborationMemberPreset(input.id),
    }),
  );

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.LIST_USER_APPROVALS,
    async (_e, input: ListCollaborationUserApprovalsInput) =>
      service.listUserApprovals(input.roomId),
  );

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.RESOLVE_USER_APPROVAL,
    async (
      _e,
      input: ResolveCollaborationUserApprovalInput,
    ): Promise<ResolveCollaborationUserApprovalResult> =>
      service.resolveUserApproval(input),
  );

  // P2-1：列出某房间的可观察「待确认续跑」项（纯函数派生，不触副作用）。
  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.LIST_CONTINUATIONS,
    async (
      _e,
      input: ListCollaborationContinuationsInput,
    ): Promise<ListCollaborationContinuationsResult> =>
      service.listContinuations(input.roomId),
  );

  // P2-1：确认继续一个 blocked run —— 新 turn（新 runId/fence），不复活旧 fence。
  // service 自带 room/run/member/trigger 校验，失败返回 { ok: false, reason }（不抛）。
  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.CONFIRM_RESUME_BLOCKED,
    async (
      _e,
      input: ConfirmResumeBlockedRunInput,
    ): Promise<ConfirmResumeBlockedRunResult> =>
      service.confirmResumeBlockedRun(input),
  );

  // ===== P2-UX 桥接：明示进房 / 明示退出 / 按需读原史（14-SESSION-COLLAB-BRIDGE-SPEC） =====
  // userConfirmed 由 renderer 传入、主进程再校验（BridgeConfirmRequiredError）。
  // 旧 UPGRADE_FROM_SESSION 保留不动（旧路径无精炼桥；新路径须走 enter-with-bridge）。
  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.ENTER_WITH_BRIDGE,
    async (
      _e,
      input: EnterCollaborationWithBridgeInput,
    ): Promise<EnterCollaborationWithBridgeResult> =>
      bridgeService.enterCollaborationWithBridge(input),
  );
  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.EXIT_WITH_BRIDGE,
    async (
      _e,
      input: ExitCollaborationWithBridgeInput,
    ): Promise<ExitCollaborationWithBridgeResult> =>
      bridgeService.exitCollaborationWithBridge(input),
  );
  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.READ_SOURCE_EXCERPT,
    async (
      _e,
      input: ReadSourceSessionExcerptInput,
    ): Promise<ReadSourceSessionExcerptResult> =>
      bridgeService.readSourceSessionExcerpt(
        input,
        input.alreadyUsedThisTurnTokens ?? 0,
      ),
  );

  // 看板任务状态变化 → 广播给「挂载了该看板」的协作室房间，让面板能及时刷新投影。
  // 复用既有 kanban CHANGED 事件，不另造真值；对每个挂载该看板的房间发 collaboration-room:changed
  // （kind 沿用 'updated'），渲染层收到后重新拉取投影。
  const boardChangedHandler = (taskId: string): void => {
    // 反查任务所属看板；取不到则跳过（任务可能已删除）
    const task = service.getTaskByIdFromKanban(taskId);
    if (!task) return;
    for (const room of service.listRooms(false)) {
      if (room.attachedBoardId === task.boardId) {
        service.broadcastBoardChanged(room.id);
      }
    }
  };
  onKanbanTaskStatusChanged(boardChangedHandler);

  console.log(
    "[协作室] IPC 已注册（list/create/get/update/list-messages/append-user-message/list-members/add-member/update-member/list-runs/cancel-run/list-mailbox/continue-depth-stop/list-room-tasks/create-room-task/update-room-task/list-artifacts/read-artifact/list-board-tasks/get-board-summary；S4.5 深度停止继续；S5 任务/产物面板 + 看板桥；P2-1 待确认续跑 list-continuations / confirm-resume-blocked；P2-UX 桥接 enter-with-bridge / exit-with-bridge / read-source-excerpt）",
  );
}
