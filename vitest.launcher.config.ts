import { defineConfig } from 'vitest/config';
// Slow subprocess/real-uvicorn regression for scripts/dev.mjs ownership. Kept out of the
// default `npm test` (see vitest.config.ts); run with `npm run test:launcher`.
export default defineConfig({ test: { include: ['tests/launcher/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 30_000 } });
