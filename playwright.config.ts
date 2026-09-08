import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve('.cache/ms-playwright');
export default defineConfig({
  testDir: './tests/e2e', timeout: 60_000, workers: 1, retries: 0,
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
  use: { baseURL: 'http://localhost:8171', trace: 'retain-on-failure' },
  webServer: {
    command: 'node scripts/test-server.mjs', url: 'http://localhost:8171/health',
    reuseExistingServer: false, timeout: 30_000,
  },
});
