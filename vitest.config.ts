import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const uiSource = fileURLToPath(new URL('./packages/ui/src', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@': uiSource,
    },
  },
  test: {
    environment: 'node',
    environmentMatchGlobs: [['packages/ui/**/*.test.tsx', 'jsdom']],
    setupFiles: ['./packages/ui/src/test/setup.ts'],
    // 这些测试文件用的是 bun:test / node:test 运行器（非 vitest），
    // vitest 的默认 glob 会误扫并因 import 'bun:test'/'node:test' 加载失败。
    // 它们应分别用 `bun test` / `node --test` 运行，这里排除以免污染 `bun run test`。
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'apps/electron/src/main/lib/permission/session-whitelist.test.ts',
      'apps/electron/src/renderer/components/chat/session-turn-model.test.ts',
      'apps/electron/src/renderer/components/chat/tool-phrase.test.ts',
      'tools/chaos-openai-proxy/server.test.mjs',
    ],
    // 满负荷并行时个别用例（如 session-store 动态 import + module reload）
    // 会撞上 vitest 默认 5s 超时；放宽到 15s 给 I/O 与模块重载留余量。
    testTimeout: 15_000,
  },
})
