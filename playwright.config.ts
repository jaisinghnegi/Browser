import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve('.cache/ms-playwright');
// Defaults to 8171/dist, matching the shared demo, so plain `npm run test:e2e` is unchanged.
// Set E2E_PORT/E2E_EXT_DIR (and build with matching BUILD_PORT/BUILD_OUT_DIR) to run fully
// isolated from a live demo on 8171 -- see package.json's test:e2e:isolated script.
const port = process.env.E2E_PORT || '8171';
export default defineConfig({
  testDir: './tests/e2e', timeout: 60_000, workers: 1, retries: 0,
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
  use: { baseURL: `http://localhost:${port}`, trace: 'retain-on-failure' },
  webServer: {
    command: 'node scripts/test-server.mjs', url: `http://localhost:${port}/health`,
    reuseExistingServer: false, timeout: 30_000, env: { E2E_PORT: port },
  },
});
