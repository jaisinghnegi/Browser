import { test, expect } from '@playwright/test';

// Every chat test stubs /api/models so readiness (which otherwise probes the real :8973) is
// deterministic; individual tests that care about the unavailable path override this.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/models', route =>
    route.fulfill({ json: { models: [{ id: 'qwen-local', name: 'Qwen', location: 'local', ready: true }] } }));
});

test('local chat sends conversation and renders model text without executing HTML', async ({ page }) => {
  const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  await page.route('**/api/chat', async route => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({ json: { provider: 'qwen-local', reply: '<img src=x onerror="window.compromised=true">Hello' } });
  });
  await page.goto('/');
  await page.getByLabel('Message Qwen').fill('Hello');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.message.assistant')).toContainText('<img src=x');
  await expect(page.locator('.message.assistant img')).toHaveCount(0);
  await page.getByLabel('Message Qwen').fill('Remember my greeting?');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.message.assistant')).toHaveCount(2);
  expect(bodies[1].messages.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
  await page.locator('#new-chat').click();
  await expect(page.locator('.message')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('model failure restores input for retry and stop suppresses late replies', async ({ page }) => {
  let release: () => void = () => {};
  let first = true;
  await page.route('**/api/chat', async route => {
    if (first) {
      first = false;
      await route.fulfill({ status: 502, json: { error: 'unavailable' } });
    } else {
      await new Promise<void>(resolve => { release = resolve; });
      await route.fulfill({ json: { provider: 'qwen-local', reply: 'Late reply' } }).catch(() => {});
    }
  });
  await page.goto('/');
  await page.getByLabel('Message Qwen').fill('Retry me');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('#notice')).toContainText('unavailable');
  await expect(page.getByLabel('Message Qwen')).toHaveValue('Retry me');
  const pending = page.waitForRequest('**/api/chat');
  await page.getByRole('button', { name: 'Send message' }).click();
  await pending;
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  release();
  await expect(page.locator('#notice')).toContainText('Stopped waiting');
  await expect(page.locator('.message.assistant')).toHaveCount(0);
  await expect(page.getByLabel('Message Qwen')).toBeEnabled();
});

test('model readiness is shown honestly: unavailable disables Send, recovers after re-probe', async ({ page }) => {
  let probe = 0;
  await page.route('**/api/models', route => {
    probe++;
    route.fulfill({ json: { models: [{ id: 'qwen-local', name: 'Qwen', location: 'local', ready: probe > 1 }] } });
  });
  await page.goto('/');
  await expect(page.locator('#status-dot')).toHaveAttribute('data-state', 'unavailable');
  await expect(page.locator('#model-state')).toHaveText('unavailable');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();

  // A 502 on send triggers a re-probe; the second probe reports ready, so the UI recovers.
  await page.route('**/api/chat', route => route.fulfill({ status: 502, json: { error: 'unavailable' } }));
  await page.getByLabel('Message Qwen').fill('hi');
  await page.keyboard.press('Enter'); // Send is disabled; Enter still submits the form
  await expect(page.locator('#status-dot')).toHaveAttribute('data-state', 'ready', { timeout: 5000 });
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
});

test('mobile workspace has usable composer and reset without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByLabel('Message Qwen')).toBeVisible();
  await page.locator('#mobile-new').click();
  await expect(page.locator('#notice')).toContainText('New conversation');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
