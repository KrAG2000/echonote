import { defineConfig } from 'vitest/config'

// Integration tests run the real whisper-server / llama-server binaries against
// the real model files. They are skipped when the binaries or models are absent.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    env: { TZ: 'Asia/Kolkata' }
  }
})
