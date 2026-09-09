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

  // Local sanitized preview (Phase 2 prototype): purely additive -- must never affect the
  // real outbound payload (already asserted above: exactly 1 request, none of the assertions
  // above changed) or leave a trace of the visible seeded secret anywhere client-observable.
  // <details> is collapsed by default, so read textContent (reflects DOM state regardless of
  // rendering) rather than innerText (requires the element to actually be laid out/visible).
  await expect(popup.locator('#preview-status')).toContainText('Not sent', { timeout: 60_000 });
  expect(requests).toHaveLength(1); // the preview build itself must never issue a request.
  const previewText = (await popup.locator('#preview-status').textContent()) ?? '';
  expect(previewText).not.toContain('71 Visible Road');
  // A real page can legitimately land in either terminal outcome this prototype supports:
  // actually redacted, or conservatively withheld (e.g. more structural text regions than the
  // bounded per-preview recognition budget allows -- see extension/preview.ts's MAX_REGIONS).
  // Both are valid; getting stuck on "Building..." past the timeout above is the only failure.
  expect(previewText).toMatch(/region\(s\) masked locally|Preview withheld/);
  if (previewText.includes('masked locally')) {
    await popup.locator('details', { hasText: 'Local sanitized preview' }).locator('summary').click();
    await expect(popup.locator('#preview-image')).toBeVisible();
  }
  await info.attach('local-preview-status', { body: previewText, contentType: 'text/plain' });
});

test('supported page produces a real nonempty masked preview with opaque GT coverage', async ({ demo, baseURL }, info) => {
  test.setTimeout(180_000); // packaged unthreaded-WASM recognition in the popup is slow
  const { page, popup, requests } = demo;
  // Smaller page: its structural text fits the preview's bounded budget, so the preview
  // reaches an actual redacted outcome instead of withholding. Same single allowed URL as far
  // as the extension is concerned (the ?variant query is stripped before the allow check).
  await page.goto(`${baseURL}/fixture?variant=preview`);
  await page.bringToFront();
  await popup.getByRole('button', { name: 'Run private fill' }).click();

  await expect(popup.locator('#preview-status')).toContainText('region(s) masked locally', { timeout: 150_000 });
  const previewText = (await popup.locator('#preview-status').textContent()) ?? '';
  expect(previewText).toMatch(/[1-9]\d* region\(s\) masked locally/); // nonempty: at least one region masked
  const planReqs = () => requests.filter(r => JSON.parse(r).url.endsWith('/plan'));
  expect(planReqs()).toHaveLength(1); // exactly the one gating request; the preview build issues none
  expect(requests.join('')).not.toContain('221 Baker Rd'); // no secret on any channel

  // Ground truth measured INDEPENDENTLY of the extension: the address line's own client rect,
  // read straight from the page DOM, scaled to device pixels exactly like the screenshot.
  // Ground truth = the address TEXT NODE's own rect (a Range over its contents), measured here
  // independently. Deliberately the same geometry the redaction targets, so a full-coverage
  // assertion is meaningful rather than testing the surrounding block's padding.
  const gt = await page.evaluate(() => {
    const el = document.querySelector('.addr')!;
    const range = document.createRange();
    range.selectNodeContents(el.firstChild!);
    const r = range.getClientRects()[0];
    return { x: r.x, y: r.y, width: r.width, height: r.height, dpr: window.devicePixelRatio };
  });

  await popup.locator('details', { hasText: 'Local sanitized preview' }).locator('summary').click();
  await expect(popup.locator('#preview-image')).toBeVisible();

  // Decode the actual redacted image bytes shown in the popup and sample a grid inside the GT
  // box. Every sample must be fully opaque near-black -> the address text is covered, not just
  // overlaid, and the mask is not translucent.
  const coverage = await popup.evaluate(async ({ gt }) => {
    const img = document.querySelector<HTMLImageElement>('#preview-image')!;
    const src = img.src;
    if (!src.startsWith('data:image/png;base64,')) return { error: 'not a png data url' };
    const bitmap = new Image();
    bitmap.src = src;
    await bitmap.decode();
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.naturalWidth; canvas.height = bitmap.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const x0 = gt.x * gt.dpr, y0 = gt.y * gt.dpr, w = gt.width * gt.dpr, h = gt.height * gt.dpr;
    let sampled = 0, opaqueBlack = 0;
    for (let fx = 0.15; fx <= 0.85; fx += 0.1) {
      for (let fy = 0.3; fy <= 0.7; fy += 0.2) {
        const px = Math.round(x0 + fx * w), py = Math.round(y0 + fy * h);
        if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue;
        const [r, g, b, a] = ctx.getImageData(px, py, 1, 1).data;
        sampled++;
        if (a === 255 && r < 16 && g < 16 && b < 16) opaqueBlack++;
      }
    }
    return { sampled, opaqueBlack, imgW: canvas.width, imgH: canvas.height };
  }, { gt });

  expect('error' in coverage ? coverage.error : '').toBe('');
  expect((coverage as { sampled: number }).sampled).toBeGreaterThan(8);
  expect((coverage as { opaqueBlack: number }).opaqueBlack).toBe((coverage as { sampled: number }).sampled);
  await info.attach('preview-gt-coverage', { body: JSON.stringify(coverage), contentType: 'application/json' });

  // And the fill flow itself still works and still leaks nothing on the planner channel.
  // (#preview-status also has role=status once its <details> is expanded above, so target #status
  // by id here rather than by role.)
  await expect(popup.locator('#status')).toHaveText('Filled locally. Task cleared.', { timeout: 30_000 });
  await expect(page.getByLabel('Shipping address', { exact: true })).toHaveValue('991 Vault Lane, Testville 00000');
  expect(planReqs()).toHaveLength(1);
  expect(requests.join('')).not.toContain('221 Baker Rd');
  expect(await readFile('test-results/server.log', 'utf8')).not.toContain('221 Baker Rd');
});

test('a second run re-arms the preview after the first is superseded', async ({ demo, baseURL }) => {
  test.setTimeout(240_000);
  const { page, popup } = demo;
  await page.goto(`${baseURL}/fixture?variant=preview`);
  await page.bringToFront();
  const terminal = /region\(s\) masked locally|Preview withheld/;

  // First run: let its preview reach a terminal state.
  await popup.getByRole('button', { name: 'Run private fill' }).click();
  await expect(popup.locator('#preview-status')).toContainText(terminal, { timeout: 150_000 });
  await expect(popup.getByRole('status')).toHaveText('Filled locally. Task cleared.', { timeout: 30_000 });
  await page.getByLabel('Shipping address', { exact: true }).fill(''); // a filled field blocks the next run

  // Second run: run.click() calls supersedePreview(), which aborts the first controller AND
  // installs a fresh one. If the fresh controller were not installed, this second build would
  // get a pre-aborted signal and always withhold 'cancelled' / never mask. It must instead
  // reach its own real terminal state.
  await popup.getByRole('button', { name: 'Run private fill' }).click();
  await expect(popup.locator('#preview-status')).toContainText(terminal, { timeout: 150_000 });
  const finalText = (await popup.locator('#preview-status').textContent()) ?? '';
  expect(finalText).not.toContain('run superseded'); // the current run's own signal is live, not aborted
  await expect(popup.getByRole('status')).toHaveText('Filled locally. Task cleared.', { timeout: 30_000 });
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
