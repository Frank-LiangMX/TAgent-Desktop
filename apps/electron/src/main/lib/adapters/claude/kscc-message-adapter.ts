/**
 * kscc 核消息转译：re-export shared（主进程 + renderer 共用同一份）
 *
 * 实现在 @tagent/shared/utils/kscc-message-adapter，这里 re-export 保持主进程 import 路径稳定。
 */
export { sdkMessageToIR } from '@tagent/shared'
