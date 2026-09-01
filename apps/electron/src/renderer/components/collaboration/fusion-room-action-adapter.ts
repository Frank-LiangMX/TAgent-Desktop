import type {
  AcquireFusionWorkspaceLockInput,
  AddFusionBotSeatInput,
  AppendFusionMessageInput,
  CommitFusionWorkspaceFileInput,
  CommitFusionWorkspaceFilesInput,
  DeleteFusionWorkspaceFileInput, MoveFusionWorkspaceFileInput,
  CreateFusionRoomTaskInput,
  UpdateFusionRoomTaskInput,
  PublishFusionArtifactInput,
  RequestFusionUserApprovalInput, ResolveFusionUserApprovalInput, SendFusionMailboxInput, ReplyFusionMailboxInput,
  FinishFusionRunInput, AwaitFusionRunInput,
  FusionAuthorityRoomStatus,
  FusionContinuationKind,
  UpdateFusionRoomMetadataInput,
  FusionRoomGatewayAction,
  RecordFusionUsageInput,
  StartFusionRunInput,
  RetryFusionRunInput,
} from '@tagent/core'
import type { CollaborationHumanMemberStatus } from '@tagent/shared'
import {
  FusionRoomViewModelController,
  type FusionRoomViewModel,
} from './fusion-room-view-model'

type RemotePresence = Extract<CollaborationHumanMemberStatus, 'active' | 'offline'>

/**
 * Page-level action facade for a remote RoomSession.
 *
 * It deliberately does not accept actorUserId. The gateway derives the actor
 * from the authenticated principal, so the renderer cannot impersonate a user.
 */
export class FusionRoomActionAdapter {
  constructor(private readonly controller: FusionRoomViewModelController) {}

  async load(): Promise<FusionRoomViewModel> {
    await this.controller.load()
    return this.requireView()
  }

  async connect(): Promise<void> {
    await this.controller.connect()
  }

  async sendMessage(
    input: Omit<AppendFusionMessageInput, 'actorUserId'>,
  ): Promise<FusionRoomViewModel> {
    return this.dispatch({ type: 'message', input })
  }

  async inviteHuman(input: { userId: string; displayName: string }): Promise<FusionRoomViewModel> {
    return this.dispatch({ type: 'invite-human', ...input })
  }

  async acceptInvitation(): Promise<FusionRoomViewModel> {
    return this.dispatch({ type: 'accept-invitation' })
  }

  async leaveHuman(): Promise<FusionRoomViewModel> {
    return this.dispatch({ type: 'leave-human' })
  }

  async removeHuman(userId: string): Promise<FusionRoomViewModel> {
    return this.dispatch({ type: 'remove-human', userId })
  }

  async setPresence(status: RemotePresence): Promise<FusionRoomViewModel> {
    return this.dispatch({ type: 'presence', status })
  }

  async addBot(input: Omit<AddFusionBotSeatInput, 'actorUserId'>): Promise<FusionRoomViewModel> {
    return this.dispatch({ type: 'add-bot', input })
  }

  async setBotConsent(seatId: string, consent: boolean): Promise<FusionRoomViewModel> {
    return this.dispatch({ type: 'bot-consent', seatId, consent })
  }

  async removeBot(seatId: string): Promise<FusionRoomViewModel> {
    return this.dispatch({ type: 'remove-bot', seatId })
  }

  async acquireWorkspaceLock(
    input: Omit<AcquireFusionWorkspaceLockInput, 'actorUserId'>,
  ): Promise<FusionRoomViewModel> {
    return this.dispatch({ type: 'lock', input })
  }

  async commitFile(
    input: Omit<CommitFusionWorkspaceFileInput, 'actorUserId'>,
  ): Promise<FusionRoomViewModel> {
    return this.dispatch({ type: 'commit-file', input })
  }

  async commitFiles(
    input: Omit<CommitFusionWorkspaceFilesInput, 'actorUserId'>,
  ): Promise<FusionRoomViewModel> {
    return this.dispatch({ type: 'commit-files', input })
  }

  async deleteFile(input: Omit<DeleteFusionWorkspaceFileInput, 'actorUserId'>): Promise<FusionRoomViewModel> {
    return this.dispatch({ type: 'delete-file', input })
  }

  async moveFile(input: Omit<MoveFusionWorkspaceFileInput, 'actorUserId'>): Promise<FusionRoomViewModel> {
    return this.dispatch({ type: 'move-file', input })
  }
  async recordUsage(
    input: Omit<RecordFusionUsageInput, 'actorUserId'>,
  ): Promise<FusionRoomViewModel> {
    return this.dispatch({ type: 'usage', input })
  }

  async startRun(input: Omit<StartFusionRunInput, 'actorUserId'>): Promise<FusionRoomViewModel> {
    return this.dispatch({ type: 'start-run', input })
  }

  async retryRun(input: Omit<RetryFusionRunInput, 'actorUserId'>): Promise<FusionRoomViewModel> {
    return this.dispatch({ type: 'retry-run', input })
  }

  async finishRun(
    input: Omit<FinishFusionRunInput, 'actorUserId'>,
  ): Promise<FusionRoomViewModel> {
    return this.dispatch({ type: 'finish-run', input })
  }

  async awaitRun(input: Omit<AwaitFusionRunInput, 'actorUserId'>): Promise<FusionRoomViewModel> {
    return this.dispatch({ type: 'await-run', input })
  }

  async createTask(input: Omit<CreateFusionRoomTaskInput, 'actorUserId'>): Promise<FusionRoomViewModel> {
    return this.dispatch({ type: 'create-task', input })
  }

  async updateTask(input: Omit<UpdateFusionRoomTaskInput, 'actorUserId'>): Promise<FusionRoomViewModel> {
    return this.dispatch({ type: 'update-task', input })
  }

  async publishArtifact(input: Omit<PublishFusionArtifactInput, 'actorUserId'>): Promise<FusionRoomViewModel> {
    return this.dispatch({ type: 'publish-artifact', input })
  }

  async requestApproval(input: Omit<RequestFusionUserApprovalInput, "actorUserId">): Promise<FusionRoomViewModel> {
    return this.dispatch({ type: "request-approval", input })
  }

  async resolveApproval(input: Omit<ResolveFusionUserApprovalInput, "actorUserId">): Promise<FusionRoomViewModel> {
    return this.dispatch({ type: "resolve-approval", input })
  }

  async sendMailbox(input: Omit<SendFusionMailboxInput, "actorUserId">): Promise<FusionRoomViewModel> {
    return this.dispatch({ type: "send-mailbox", input })
  }

  async replyMailbox(input: Omit<ReplyFusionMailboxInput, "actorUserId">): Promise<FusionRoomViewModel> {
    return this.dispatch({ type: "reply-mailbox", input })
  }

  async confirmResumeContinuation(
    input: { continuationId: string; kind: FusionContinuationKind; idempotencyKey?: string },
  ): Promise<FusionRoomViewModel> {
    const roomId = this.controller.currentView?.roomId
    if (!roomId) throw new Error('远程 RoomSession 尚未加载权威快照')
    // roomId 由已加载快照注入；wire payload 不含 actorUserId（gateway 由 principal 注入）。
    return this.dispatch({ type: 'confirm-resume-continuation', input: { ...input, roomId } })
  }

  async updateMetadata(input: Omit<UpdateFusionRoomMetadataInput, 'actorUserId'>): Promise<FusionRoomViewModel> {
    return this.dispatch({ type: 'update-metadata', input })
  }

  async setStatus(status: FusionAuthorityRoomStatus): Promise<FusionRoomViewModel> {
    return this.dispatch({ type: 'status', status })
  }

  async close(): Promise<void> {
    await this.controller.close()
  }

  private async dispatch(action: FusionRoomGatewayAction): Promise<FusionRoomViewModel> {
    if (!this.controller.currentView) {
      throw new Error('远程 RoomSession 尚未加载权威快照')
    }
    await this.controller.dispatch(action)
    return this.requireView()
  }

  private requireView(): FusionRoomViewModel {
    const view = this.controller.currentView
    if (!view) throw new Error('远程 RoomSession 尚未加载权威快照')
    return view
  }
}
