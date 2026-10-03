import { defineConfig } from 'vitest/config'

// End-to-end tests launch the built Electron app (run `npm run build` first).
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.e2e.test.ts'],
    environment: 'node',
    testTimeout: 300_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    sequence: { concurrent: false }
  }
})
