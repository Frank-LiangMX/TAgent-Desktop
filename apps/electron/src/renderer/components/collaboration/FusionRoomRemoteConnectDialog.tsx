/**
 * 连接远程融合会话对话框。
 *
 * 收集对端 RoomSession 服务地址、房间 ID 与可选访问令牌，提交时调用
 * createFusionRoomRemoteSession 构造本地会话句柄，成功后经 onConnected 交回调用方
 * （由 CollaborationRoomsPage 挂载 FusionRoomRemotePage 渲染）。
 *
 * 安全约束：访问令牌仅存于组件内存态，不写 localStorage / 数据库 / 日志；提交时
 * 仅以 `token.trim() || undefined` 传给 createFusionRoomRemoteSession，由其注入 HTTP
 * 头部，不在本组件内 console.log 或持久化。
 */
import { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@tagent/ui";
import {
  createFusionRoomRemoteSession,
  type FusionRoomRemoteSession,
} from "./fusion-room-remote-session";

export interface FusionRoomRemoteConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 成功建立会话后回调（调用方负责渲染并关闭本对话框）。 */
  onConnected: (session: FusionRoomRemoteSession) => void;
}

export function FusionRoomRemoteConnectDialog({
  open,
  onOpenChange,
  onConnected,
}: FusionRoomRemoteConnectDialogProps): JSX.Element {
  const [baseUrl, setBaseUrl] = useState("");
  const [roomId, setRoomId] = useState("");
  // 访问令牌仅内存态，关闭/提交后随组件态消失，不持久化、不写日志。
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 打开时清空表单与错误（避免上次输入/失败信息残留）。
  useEffect(() => {
    if (!open) return;
    setBaseUrl("");
    setRoomId("");
    setToken("");
    setError(null);
    setSubmitting(false);
  }, [open]);

  const submit = async (): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const session = createFusionRoomRemoteSession({
        baseUrl,
        roomId,
        token: token.trim() || undefined,
      });
      onConnected(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = !submitting && baseUrl.trim().length > 0 && roomId.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(440px,calc(100vw-32px))] gap-0 p-0 sm:max-w-none">
        <DialogHeader className="space-y-2 px-5 pt-5 text-left">
          <DialogTitle className="text-[15px]">连接远程融合会话</DialogTitle>
          <DialogDescription className="text-[12.5px] leading-5">
            输入对端 RoomSession 服务地址与房间 ID，连接后可在本端查看时间线并发送消息；也可用于接入其他设备上的融合会话。
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4 px-5 py-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) void submit();
          }}
        >
          <div>
            <label
              className="text-xs text-muted-foreground"
              htmlFor="fusion-remote-base-url"
            >
              服务地址
            </label>
            <Input
              id="fusion-remote-base-url"
              className="mt-1.5"
              value={baseUrl}
              placeholder="https://host:port"
              onChange={(event) => setBaseUrl(event.target.value)}
              disabled={submitting}
              autoFocus
            />
          </div>

          <div>
            <label
              className="text-xs text-muted-foreground"
              htmlFor="fusion-remote-room-id"
            >
              房间 ID
            </label>
            <Input
              id="fusion-remote-room-id"
              className="mt-1.5"
              value={roomId}
              placeholder="例如：room-release"
              onChange={(event) => setRoomId(event.target.value)}
              disabled={submitting}
            />
          </div>

          <div>
            <label
              className="text-xs text-muted-foreground"
              htmlFor="fusion-remote-token"
            >
              访问令牌（可选）
            </label>
            <Input
              id="fusion-remote-token"
              type="password"
              className="mt-1.5"
              value={token}
              placeholder="留空表示匿名访问"
              onChange={(event) => setToken(event.target.value)}
              disabled={submitting}
            />
          </div>

          {error ? (
            <p
              role="alert"
              className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {error}
            </p>
          ) : null}

          <DialogFooter className="gap-2 pt-1 sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              取消
            </Button>
            <Button type="submit" size="sm" disabled={!canSubmit}>
              {submitting ? "连接中…" : "连接"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
