import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Real WebSocket sockets + crypto; give a little headroom over the default.
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
