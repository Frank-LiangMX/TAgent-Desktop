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
  },
})
