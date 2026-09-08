// Captures a real screenshot of every fixture's *clean* page (fixtures/phase2/pages/, no
// data-gt-* attributes) at its declared reference viewport/DPR. This is the input the
// detection pipeline (detect.mjs) actually runs against -- deliberately not the labeled tree,
// so detection never has access to (or any appearance of using) the answer key.
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = new URL('../../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('fixtures/phase2/manifest.json', root), 'utf8'));
const outDir = new URL('fixtures/phase2/screenshots/', root);
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
for (const entry of manifest) {
  const context = await browser.newContext({
    viewport: { width: entry.referenceViewport.width, height: entry.referenceViewport.height },
    deviceScaleFactor: entry.referenceViewport.devicePixelRatio,
  });
  const page = await context.newPage();
  await page.goto(new URL(`fixtures/phase2/pages/${entry.id}.html`, root).href);
  await page.screenshot({ path: fileURLToPath(new URL(`${entry.id}.png`, outDir)) });
  await context.close();
}
await browser.close();
console.log(`Captured ${manifest.length} screenshots.`);
