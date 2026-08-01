/**
 * 流式 markdown 围栏检测（自研）
 *
 * 逻辑单一事实源已移至 @tagent/shared（rich-output-validate），
 * 此处 re-export 保持既有 import 方不变。
 */
export {
  RICH_FENCE_LANGUAGES,
  isRichFenceLanguage,
  unclosedFenceLanguage,
} from '@tagent/shared'
