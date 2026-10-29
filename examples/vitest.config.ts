import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // pnpm runs each package's tests in parallel, and Vitest's default module
    // cache is shared at the workspace root, where concurrent runs can race.
    fsModuleCachePath: fileURLToPath(new URL('./node_modules/.vitest-cache', import.meta.url)),
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Each SLH-DSA signature takes about 0.6 s, and @qbit-oss/pqc loads its WASM module once per test file.
    testTimeout: 30_000,
  },
})
