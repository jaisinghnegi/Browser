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
  const SECRET = '14 Baker Rd, Testville 00000'; // the actual fixture value being redacted
  const VAULT = '991 Vault Lane, Testville 00000'; // filled locally, must never be on the wire
  const planReqs = () => requests.filter(r => JSON.parse(r).url.endsWith('/plan'));
  expect(planReqs()).toHaveLength(1); // exactly the one gating request; the preview build issues none
  expect(requests.join('')).not.toContain(SECRET);
  expect(requests.join('')).not.toContain(VAULT);

  // Ground truth measured INDEPENDENTLY of the extension: the TEXT NODE's own rect (a Range
  // over its contents) for both the sensitive address and a benign label -- the same geometry
  // the redaction targets, so full-coverage / survival assertions are meaningful.
  const boxes = await page.evaluate(() => {
    const rectOf = (sel: string) => {
      const el = document.querySelector(sel)!;
      const range = document.createRange();
      range.selectNodeContents(el.firstChild!);
      const r = range.getClientRects()[0];
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    return { dpr: window.devicePixelRatio, secret: rectOf('.addr'), benign: rectOf('label[for="shipping-address"]') };
  });

  await popup.locator('details', { hasText: 'Local sanitized preview' }).locator('summary').click();
  await expect(popup.locator('#preview-image')).toBeVisible();

  // Decode the ACTUAL redacted PNG bytes shown in the popup. Scan EVERY pixel across each
  // independently-measured box (rounded inward, clamped to image bounds):
  //  - secret box: every pixel must be fully opaque near-black (covered + opaque, not a
  //    translucent overlay);
  //  - benign box: must retain substantial non-black content (guards against "mask everything"
  //    / an all-black image passing).
  const scan = await popup.evaluate(async ({ boxes }) => {
    const img = document.querySelector<HTMLImageElement>('#preview-image')!;
    if (!img.src.startsWith('data:image/png;base64,')) return { error: 'not a png data url' };
    const bitmap = new Image(); bitmap.src = img.src; await bitmap.decode();
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.naturalWidth; canvas.height = bitmap.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const measure = (b: { x: number; y: number; width: number; height: number }) => {
      const x0 = Math.max(0, Math.ceil(b.x * boxes.dpr));
      const y0 = Math.max(0, Math.ceil(b.y * boxes.dpr));
      const x1 = Math.min(canvas.width, Math.floor((b.x + b.width) * boxes.dpr));
      const y1 = Math.min(canvas.height, Math.floor((b.y + b.height) * boxes.dpr));
      const w = Math.max(0, x1 - x0), h = Math.max(0, y1 - y0);
      if (w === 0 || h === 0) return { total: 0, opaqueBlack: 0, nonBlack: 0 };
      const d = ctx.getImageData(x0, y0, w, h).data;
      let opaqueBlack = 0, nonBlack = 0;
      for (let i = 0; i < d.length; i += 4) {
        const [r, g, b2, a] = [d[i], d[i + 1], d[i + 2], d[i + 3]];
        if (a === 255 && r < 16 && g < 16 && b2 < 16) opaqueBlack++;
        else nonBlack++;
      }
      return { total: d.length / 4, opaqueBlack, nonBlack };
    };
    return { secret: measure(boxes.secret), benign: measure(boxes.benign), imgW: canvas.width, imgH: canvas.height };
  }, { boxes });

  expect('error' in scan ? scan.error : '').toBe('');
  const s = scan as { secret: { total: number; opaqueBlack: number }; benign: { total: number; nonBlack: number } };
  await info.attach('preview-pixel-scan', { body: JSON.stringify(scan), contentType: 'application/json' });
  expect(s.secret.total).toBeGreaterThan(500);            // a real, non-degenerate box
  expect(s.secret.opaqueBlack).toBe(s.secret.total);      // 100% of the secret box is opaque black
  expect(s.benign.total).toBeGreaterThan(200);
  expect(s.benign.nonBlack / s.benign.total).toBeGreaterThan(0.5); // benign label survived, not masked

  // And the fill flow itself still works and still leaks nothing on the planner channel.
  // (#preview-status also has role=status once its <details> is expanded above, so target #status
  // by id here rather than by role.)
  await expect(popup.locator('#status')).toHaveText('Filled locally. Task cleared.', { timeout: 30_000 });
  await expect(page.getByLabel('Shipping address', { exact: true })).toHaveValue(VAULT);
  expect(planReqs()).toHaveLength(1);
  expect(requests.join('')).not.toContain(SECRET);
  expect(await readFile('test-results/server.log', 'utf8')).not.toContain(SECRET);
});

test('a second run started mid-build supersedes the first and still reaches its own result', async ({ demo, baseURL }) => {
  test.setTimeout(240_000);
  const { page, popup } = demo;
  // Multi-line page so the first build is genuinely in flight when the second run starts,
  // exercising overlapping builds (per-build RecognizerSession ownership) and supersede.
  await page.goto(`${baseURL}/fixture?variant=preview-multi`);
  await page.bringToFront();
  const terminal = /region\(s\) masked locally|Preview withheld/;

  await popup.getByRole('button', { name: 'Run private fill' }).click();
  // Start the second run WHILE the first build is in flight (fire it synchronously the moment
  // "Building…" appears, before the first fill even completes -- so the field is still empty).
  const started = await popup.evaluate(async () => {
    const ps = document.querySelector('#preview-status')!;
    const t0 = Date.now();
    while (ps.textContent !== 'Building local sanitized preview…') {
      if (Date.now() - t0 > 30_000) return false;
      await new Promise(r => setTimeout(r, 20));
    }
    (document.querySelector('#run') as HTMLButtonElement).click();
    return true;
  });
  expect(started).toBe(true);

  // supersedePreview() aborted the first controller and installed a fresh one; the first
  // build's abandoned result must never surface, and the second build must reach its own real
  // terminal state (not a pre-aborted 'cancelled').
  await expect(popup.locator('#preview-status')).toContainText(terminal, { timeout: 150_000 });
  const finalText = (await popup.locator('#preview-status').textContent()) ?? '';
  expect(finalText).not.toContain('cancelled'); // the current run's own signal is live
  await expect(popup.getByRole('status')).toHaveText('Filled locally. Task cleared.', { timeout: 30_000 });
});

test('Cancel during an in-flight preview build abandons it and never publishes a result', async ({ demo, baseURL }) => {
  test.setTimeout(180_000);
  const { page, popup } = demo;
  // Eight structural lines => an eight-call build that runs for a few seconds; "Building…" is
  // set synchronously when the capture arrives, so acting on it lands mid-build.
  await page.goto(`${baseURL}/fixture?variant=preview-multi`);
  await page.bringToFront();
  await popup.getByRole('button', { name: 'Run private fill' }).click();

  // Catch the build mid-flight and fire Cancel as a synchronous DOM click (no Playwright
  // actionability wait) so it lands within a few ms of "Building…" appearing, well before the
  // multi-second build finishes.
  const cancelledInFlight = await popup.evaluate(async () => {
    const ps = document.querySelector('#preview-status')!;
    const btn = document.querySelector('#cancel') as HTMLButtonElement;
    const t0 = Date.now();
    while (ps.textContent !== 'Building local sanitized preview…') {
      if (Date.now() - t0 > 30_000) return { ok: false, reason: 'never started building' };
      await new Promise(r => setTimeout(r, 20));
    }
    if (btn.disabled) return { ok: false, reason: 'cancel disabled during build' };
    btn.click();
    return { ok: true, statusAfter: ps.textContent };
  });
  expect(cancelledInFlight).toEqual({ ok: true, statusAfter: 'Not sent. Preview cancelled.' });

  // Abandoned: explicit terminal state, no masked image, and it STAYS that way past the point
  // the abandoned build would have finished internally -- its aborted result is never published.
  await expect(popup.locator('#preview-status')).toHaveText('Not sent. Preview cancelled.');
  await expect(popup.locator('#preview-image')).toBeHidden();
  await page.waitForTimeout(15_000);
  await expect(popup.locator('#preview-status')).toHaveText('Not sent. Preview cancelled.');
  await expect(popup.locator('#preview-image')).toBeHidden();
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
