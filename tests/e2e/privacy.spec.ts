import { test as base, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { readFile, cp, writeFile } from 'node:fs/promises';

type Demo = { context: BrowserContext; page: Page; popup: Page; requests: string[] };
const test = base.extend<{ demo: Demo; breakModel: boolean }>({
  breakModel: [false, { option: true }],
  demo: async ({ baseURL, breakModel }, use, info) => {
    // Matches playwright.config.ts's E2E_PORT default: an isolated run points both at a
    // different built extension (BUILD_PORT/BUILD_OUT_DIR at build time) and a different
    // E2E_EXT_DIR here, so it never touches the shared dist/ a live demo may have loaded.
    const extDir = process.env.E2E_EXT_DIR || 'dist';
    let extension = resolve(extDir);
    if (breakModel) {
      extension = info.outputPath('broken-extension');
      await cp(resolve(extDir), extension, { recursive: true });
      await writeFile(resolve(extension, 'models/text-detector.onnx'), 'invalid model');
    }
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium', headless: true, viewport: { width: 1000, height: 800 },
      executablePath: process.env.PRIVACY_CHROMIUM_EXECUTABLE,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--enable-unsafe-extension-debugging'],
    });
    try {
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
      const id = new URL(worker.url()).host;
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(`${baseURL}/fixture`);
      await page.bringToFront();
      const requests: string[] = [];
      context.on('request', req => {
        if (req.url().startsWith('http')) requests.push(JSON.stringify({ url: req.url(), body: req.postData() }));
      });
      const browserCdp = await context.browser()!.newBrowserCDPSession();
      const { targetInfos } = await browserCdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
      const targetInfo = targetInfos.find(target => target.url === `${baseURL}/fixture`);
      if (!targetInfo) throw new Error('Fixture tab target not found');
      await browserCdp.send('Extensions.triggerAction', { id, targetId: targetInfo.targetId });
      // Chrome's toolbar popup is an `other` CDP target, which Playwright does not expose.
      // The real action grants activeTab; drive the same packaged UI in an extension tab.
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${id}/popup.html`);
      await page.bringToFront();
      await popup.waitForLoadState('domcontentloaded');
      await use({ context, page, popup, requests });
    } finally { await context.close(); }
  },
});

test('invalid field blocks before any upload', async ({ demo }) => {
  await demo.page.getByLabel('Shipping address', { exact: true }).evaluate(node => (node as HTMLInputElement).readOnly = true);
  await demo.popup.getByRole('button', { name: 'Run private fill' }).click();
  await expect(demo.popup.getByRole('status')).toContainText('Blocked');
  await expect(demo.popup.getByRole('status')).toHaveAttribute('data-reason', 'observation-failed');
  expect(demo.requests).toHaveLength(0);
  await expect(demo.page.getByLabel('Shipping address', { exact: true })).toHaveValue('');
});

test('a nonempty field is reported distinctly and blocks before any upload', async ({ demo }) => {
  await demo.page.getByLabel('Shipping address', { exact: true }).fill('already filled');
  await demo.popup.getByRole('button', { name: 'Run private fill' }).click();
  await expect(demo.popup.getByRole('status')).toContainText('Blocked');
  await expect(demo.popup.getByRole('status')).toHaveAttribute('data-reason', 'field-not-empty');
  expect(demo.requests).toHaveLength(0);
  await expect(demo.page.getByLabel('Shipping address', { exact: true })).toHaveValue('already filled');
});

test.describe('failed local vision', () => {
  test.use({ breakModel: true });
  test('unloadable model causes zero upload', async ({ demo }) => {
    await demo.popup.getByRole('button', { name: 'Run private fill' }).click();
    await expect(demo.popup.getByRole('status')).toHaveText('Blocked: vision, planner or freshness check failed.', { timeout: 30_000 });
    await expect(demo.popup.getByRole('status')).toHaveAttribute('data-reason', 'vision-failed');
    // Proves the block happened before/at inference, not via an unrelated observation failure
    // that never reached the model.
    await expect(demo.popup.locator('#metrics')).toBeEmpty();
    expect(demo.requests).toHaveLength(0);
    await expect(demo.page.getByLabel('Shipping address', { exact: true })).toHaveValue('');
  });
});

for (const [name, change] of [
  ['wrong target', { target: '99999999-9999-4999-8999-999999999999' }],
  ['unknown reference', { valueRef: 'PASSWORD_1' }],
  ['extra executable field', { script: 'alert(1)' }],
  ['another observation', { observationId: '99999999-9999-4999-8999-999999999999' }],
] as const) {
  test(`rejects planner action with ${name}`, async ({ demo }) => {
    let actionDelivered = false;
    let hits = 0;
    await demo.context.route('**/plan', async route => {
      hits++;
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), ...change } });
      actionDelivered = true;
    });
    await demo.popup.getByRole('button', { name: 'Run private fill' }).click();
    await expect(demo.popup.getByRole('status')).toContainText('Blocked', { timeout: 30_000 });
    await expect(demo.popup.getByRole('status')).toHaveAttribute('data-reason', 'planner-action-rejected');
    expect(actionDelivered).toBe(true);
    expect(hits).toBe(1);
    // Proves the malicious action actually reached the wire and was rejected downstream of
    // the fetch, not that the run died before the fetch ever happened.
    expect(demo.requests).toHaveLength(1);
    await expect(demo.page.getByLabel('Shipping address', { exact: true })).toHaveValue('');
  });
}

test('real local vision fills the intended field without planner-channel leakage', async ({ demo, baseURL }, info) => {
  const { page, popup, requests } = demo;
  await popup.getByRole('button', { name: 'Run private fill' }).click();
  await expect(popup.getByRole('status')).toHaveText('Filled locally. Task cleared.', { timeout: 30_000 });
  await expect(popup.getByRole('status')).toHaveAttribute('data-reason', 'success');
  await expect(page.getByLabel('Shipping address', { exact: true })).toHaveValue('991 Vault Lane, Testville 00000');
  await expect(popup.locator('#metrics')).toContainText('PP-OCRv4');
  await expect(popup.locator('#metrics')).toContainText('text pixels');
  expect(requests).toHaveLength(1);
  const request = JSON.parse(requests[0]);
  expect(request.url).toBe(`${baseURL}/plan`);
  const payload = JSON.parse(request.body);
  expect(Object.keys(payload).sort()).toEqual(['fieldKind', 'observationId', 'protocol', 'target', 'taskId', 'valueRef']);
  for (const secret of ['991 Vault Lane', '71 Visible Road', 'Sample City', 'Testville']) {
    expect(requests.join('')).not.toContain(secret);
    expect(await readFile('test-results/server.log', 'utf8')).not.toContain(secret);
  }
  await info.attach('local-inference', { body: await popup.locator('#metrics').innerText(), contentType: 'text/plain' });
});

test('target replacement during delayed planning blocks the fill', async ({ demo }) => {
  const { context, page, popup } = demo;
  let replaced = false;
  await context.route('**/plan', async route => {
    const response = await route.fetch();
    await page.getByLabel('Shipping address', { exact: true }).evaluate(node => node.replaceWith(node.cloneNode(true)));
    replaced = true;
    await route.fulfill({ response });
  });
  await popup.getByRole('button', { name: 'Run private fill' }).click();
  await expect(popup.getByRole('status')).toContainText('Blocked', { timeout: 30_000 });
  await expect(popup.getByRole('status')).toHaveAttribute('data-reason', 'stale-observation');
  expect(replaced).toBe(true);
  await expect(page.getByLabel('Shipping address', { exact: true })).toHaveValue('');
});

test('cancellation while the planner is pending prevents execution', async ({ demo }) => {
  const { context, page, popup } = demo;
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let arrived!: () => void;
  const arrival = new Promise<void>(resolve => { arrived = resolve; });
  await context.route('**/plan', async route => {
    const response = await route.fetch();
    arrived();
    await released;
    await route.fulfill({ response }).catch(() => {});
  });
  await popup.getByRole('button', { name: 'Run private fill' }).click();
  await arrival;
  await popup.getByRole('button', { name: 'Cancel', exact: true }).click();
  release();
  await expect(popup.getByRole('status')).toHaveText('Cancelled. Task cleared.');
  await expect(popup.getByRole('status')).toHaveAttribute('data-reason', 'cancelled');
  await expect(page.getByLabel('Shipping address', { exact: true })).toHaveValue('');
});

test('a replayed response cannot fill a new task', async ({ demo }) => {
  const { context, page, popup } = demo;
  let saved: unknown;
  let delivered = 0;
  await context.route('**/plan', async route => {
    const response = await route.fetch();
    saved ??= await response.json();
    await route.fulfill({ response, json: saved });
    delivered++;
  });
  await popup.getByRole('button', { name: 'Run private fill' }).click();
  await expect(popup.getByRole('status')).toHaveText('Filled locally. Task cleared.', { timeout: 30_000 });
  await page.getByLabel('Shipping address', { exact: true }).fill('');
  await popup.getByRole('button', { name: 'Run private fill' }).click();
  await expect(popup.getByRole('status')).toContainText('Blocked', { timeout: 30_000 });
  await expect(popup.getByRole('status')).toHaveAttribute('data-reason', 'planner-action-rejected');
  expect(delivered).toBe(2);
  await expect(page.getByLabel('Shipping address', { exact: true })).toHaveValue('');
});

test('navigation while planning clears the old destination', async ({ demo, baseURL }) => {
  const { context, page, popup } = demo;
  let navigated = false;
  await context.route('**/plan', async route => {
    const response = await route.fetch();
    await page.goto(`${baseURL}/fixture?new-document`);
    navigated = true;
    await route.fulfill({ response }).catch(() => {});
  });
  await popup.getByRole('button', { name: 'Run private fill' }).click();
  await expect(popup.getByRole('status')).toHaveText('Blocked: page navigated. Task cleared.', { timeout: 30_000 });
  await expect(popup.getByRole('status')).toHaveAttribute('data-reason', 'navigated');
  await expect(page).toHaveURL(`${baseURL}/fixture?new-document`);
  expect(navigated).toBe(true);
  await expect(page.getByLabel('Shipping address', { exact: true })).toHaveValue('');
});

test('closing the popup aborts a pending planner request', async ({ demo }) => {
  const { context, page, popup } = demo;
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let arrived!: () => void;
  const arrival = new Promise<void>(resolve => { arrived = resolve; });
  await context.route('**/plan', async route => {
    const response = await route.fetch();
    arrived();
    await released;
    await route.fulfill({ response }).catch(() => {});
  });
  await popup.getByRole('button', { name: 'Run private fill' }).click();
  await arrival;
  const aborted = context.waitForEvent('requestfailed', { predicate: request => request.url().endsWith('/plan') });
  await popup.close();
  release();
  await aborted;
  await expect(page.getByLabel('Shipping address', { exact: true })).toHaveValue('');
});
