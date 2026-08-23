/**
 * 默认成员后端装配工厂（P1-2c）。
 *
 * 把 {@link ChannelMemberSessionLifecycleAdapter} 与
 * {@link createChannelBackendAdapter}`(lifecycle)` 配对一个**共享栈**：adapter 的 runTurn 经
 * `lifecycle.bindTurnAbort` 把 `input.signal` 与该 session 的 interrupt controller 组合成一个
 * AbortSignal 透传给 runner，使 `lifecycle.interruptSession` 能取消进行中的 turn。
 *
 * - {@link CollaborationRoomService} 默认装配本栈（生产路径：本地协作室本就在跑模型），
 *   `cancelRun` 据此走 `interruptSession`。
 * - Fusion runtime 在 `enableDefaultMemberExecution=true` 且未传 `memberAdapter` 时也复用本栈，
 *   默认仍不自动开执行/网络。
 *
 * 放在独立文件而非 `member-backend-adapter.ts`：`member-session-lifecycle.ts` 已 import
 * `member-backend-adapter.ts`（`resolveChannelBackendConfig` / `MemberBackendResolveError`），
 * 若反向再 import 会形成循环；本工厂只被 service / runtime 在运行期调用，单向依赖更稳。
 */
import { createChannelBackendAdapter } from "./member-backend-adapter";
import { ChannelMemberSessionLifecycleAdapter } from "./member-session-lifecycle";
import type { MemberBackendAdapter } from "@tagent/shared";

/**
 * 装配一个共享同一 {@link ChannelMemberSessionLifecycleAdapter} 的默认成员后端栈。
 *
 * 返回的 `adapter` 已绑定到返回的 `lifecycle`：runTurn 内 `bindTurnAbort` 组合 signal，
 * `interruptSession` 即可取消进行中的 turn。两者必须成对使用——单独拿 `adapter` 而丢弃
 * `lifecycle` 会使 interruptSession 无从寻址（adapter 仍能跑，但失去 interrupt 取消能力）。
 */
export function createDefaultChannelMemberStack(): {
  lifecycle: ChannelMemberSessionLifecycleAdapter;
  adapter: MemberBackendAdapter;
} {
  const lifecycle = new ChannelMemberSessionLifecycleAdapter();
  return { lifecycle, adapter: createChannelBackendAdapter(lifecycle) };
}
