/**
 * 知识库受控写入门控服务（kb_propose_save，刀 1）
 *
 * 仿 agent-exit-plan-service.ts 的 Promise + pending Map 异步等待模式：
 * - Agent 调用 kb_propose_save → 工具层先做绑定/标题/正文/越权校验（失败立即 error，不弹 UI）
 * - 校验通过后调用 {@link KbProposeSaveService.handleProposeSave}：把确认请求推到渲染层横幅，
 *   阻塞等待用户 confirm / reject；会话停止 / run 中止则 clearSessionPending / signal abort 兜底 reject
 * - confirm → 调 createKnowledgeBaseDocument 写入当前绑定库 → resolve ok:true + documentId
 * - reject / abort → resolve ok:false（零写入）
 *
 * 门控逻辑放在工具 execute 内（非 canUseTool 权限钩子），双核（Pi / kscc MCP）统一走同一段 await，
 * 避免自定义工具是否被 canUseTool 覆盖的差异。见 KB-P1-5-CONTROLLED-WRITE-brief §B。
 *
 * @see docs/dev/knowledge-base/KB-P1-5-CONTROLLED-WRITE-brief.md
 * @see docs/dev/knowledge-base/KB-AGENT-MODE-DESIGN.md
 */
import { randomUUID } from "node:crypto";
import type {
  KbProposeSaveAction,
  KbProposeSaveKind,
  KbProposeSaveRequest,
  KnowledgeBaseStructuredDraft,
  KbProposeSaveResponse,
  KbProposeSaveResult,
} from "@tagent/shared";
import { isKnowledgeBaseDocumentKind } from "@tagent/shared";
import { listKnowledgeBases } from "./knowledge-base-store";
import { createKnowledgeBaseDocument } from "./knowledge-base-document-store";

/** 受控写入入参（工具层校验通过后传给本服务） */
export interface KbProposeSaveInput {
  knowledgeBaseId: string;
  title: string;
  content: string;
  kind?: KbProposeSaveKind;
  draft?: KnowledgeBaseStructuredDraft;
}

/** handleProposeSave 依赖：渲染层推送回调 + 可选 run 级 abort signal */
export interface KbProposeSaveDeps {
  /** 把确认请求推到渲染层（主进程 → 渲染进程 IPC） */
  sendToRenderer: (request: KbProposeSaveRequest) => void;
  /** 可选 run 级 abort signal（kscc/Pi 工具 execute 不一定能拿到，缺省时靠 clearSessionPending 兜底） */
  signal?: AbortSignal;
}

interface PendingProposeSave {
  resolve: (result: KbProposeSaveResult) => void;
  request: KbProposeSaveRequest;
  input: KbProposeSaveInput;
}

/**
 * 知识库受控写入门控服务（单例，管理所有会话的 propose-save 请求）。
 *
 * 不做绑定/越权校验：那些在工具层（handleKbProposeSave）完成，失败直接 error 不进本服务。
 * 本服务只负责「已校验通过 → 弹横幅 → 等用户 → 写入或拒绝」的门控闭环。
 */
export class KbProposeSaveService {
  /** 待处理的请求 Map（requestId → PendingProposeSave） */
  private pendingRequests = new Map<string, PendingProposeSave>();

  /**
   * 处理 kb_propose_save 工具调用：推送确认请求到渲染层，阻塞等待用户选择。
   * 调用前工具层已校验绑定 / 标题 / 正文 / 越权 / 库存在；本服务不再重复校验。
   */
  handleProposeSave(
    sessionId: string,
    input: KbProposeSaveInput,
    deps: KbProposeSaveDeps,
  ): Promise<KbProposeSaveResult> {
    const knowledgeBaseName =
      listKnowledgeBases().find((kb) => kb.id === input.knowledgeBaseId)?.name ??
      "";

    const request: KbProposeSaveRequest = {
      requestId: randomUUID(),
      sessionId,
      knowledgeBaseId: input.knowledgeBaseId,
      knowledgeBaseName,
      title: input.title,
      content: input.content,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.draft ? { draft: input.draft } : {}),
    };

    deps.sendToRenderer(request);

    return new Promise<KbProposeSaveResult>((resolve) => {
      this.pendingRequests.set(request.requestId, { resolve, request, input });

      // run 级 abort（若有 signal）：直接 resolve aborted 并清 pending。
      // 无 signal 时靠 clearSessionPending（会话停止 / 删除）兜底。
      if (deps.signal) {
        deps.signal.addEventListener(
          "abort",
          () => {
            if (this.pendingRequests.has(request.requestId)) {
              this.pendingRequests.delete(request.requestId);
              resolve({ ok: false, reason: "aborted" });
            }
          },
          { once: true },
        );
      }
    });
  }

  /**
   * 响应 kb_propose_save 请求（由 IPC handler 调用）。
   * confirm → 写入正式文档并 resolve ok:true；reject → resolve ok:false。
   * @returns 所属 sessionId（供调用方推 RESOLVED 让渲染层出队）；未找到返回 null
   */
  respond(
    response: KbProposeSaveResponse,
  ): { sessionId: string; action: KbProposeSaveAction } | null {
    const pending = this.pendingRequests.get(response.requestId);
    if (!pending) return null;
    this.pendingRequests.delete(response.requestId);
    const sessionId = pending.request.sessionId;

    if (response.action === "confirm") {
      try {
        const now = Date.now();
        const doc = createKnowledgeBaseDocument({
          knowledgeBaseId: pending.input.knowledgeBaseId,
          title: pending.input.title,
          content: pending.input.content,
          // 刀 2 §A：入参带 kind 则写入文档；snapshot 写 snapshotAt；统一记沉淀来源。
          ...(isKnowledgeBaseDocumentKind(pending.input.kind)
            ? { kind: pending.input.kind }
            : {}),
          ...(pending.input.kind === "snapshot" ? { snapshotAt: now } : {}),
          originNote: "由会话确认沉淀（kb_propose_save）",
          ...(pending.input.draft?.summary ? { summary: pending.input.draft.summary } : {}),
          ...(pending.input.draft?.sources ? { sources: pending.input.draft.sources } : {}),
          ...(pending.input.draft?.warnings ? { parseWarnings: pending.input.draft.warnings } : {}),
          ...(pending.input.draft?.uncertainties ? { uncertainties: pending.input.draft.uncertainties } : {}),
          author: "agent",
          status: "confirmed",
        });
        pending.resolve({
          ok: true,
          documentId: doc.id,
          knowledgeBaseId: doc.knowledgeBaseId,
          title: doc.title,
        });
        return { sessionId, action: "confirm" };
      } catch (err) {
        // 罕见竞态：横幅弹出后库被删 / 标题被外部清空等导致 create 抛错 → 未写入，诚实回报
        const message = err instanceof Error ? err.message : String(err);
        pending.resolve({
          ok: false,
          reason: "write_failed",
          error: message,
        });
        return { sessionId, action: "confirm" };
      }
    }

    pending.resolve({ ok: false, reason: "user_rejected" });
    return { sessionId, action: "reject" };
  }

  /**
   * 获取当前所有待处理的 propose-save 请求（渲染进程重载后恢复状态用）。
   */
  getPendingRequests(): KbProposeSaveRequest[] {
    return [...this.pendingRequests.values()].map((p) => p.request);
  }

  /**
   * 清除指定会话的所有待处理请求（会话停止 / 删除时调用）。
   * @returns 被清除的 requestId 列表（供调用方推 KB_PROPOSE_SAVE_RESOLVED 让渲染层出队，避免停后残留横幅）
   */
  clearSessionPending(sessionId: string): string[] {
    const cleared: string[] = [];
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.request.sessionId === sessionId) {
        pending.resolve({ ok: false, reason: "aborted" });
        this.pendingRequests.delete(requestId);
        cleared.push(requestId);
      }
    }
    return cleared;
  }
}

/** 全局受控写入服务实例 */
export const kbProposeSaveService = new KbProposeSaveService();
