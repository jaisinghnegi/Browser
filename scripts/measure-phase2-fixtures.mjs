// Measures real, rendered CSS bounding boxes for each fixture's ground-truth regions --
// independent of any detector/model output, per the Phase 2 plan's requirement that ground
// truth be "positive measured CSS bounds", not authored/guessed coordinates. Also
// cross-checks that the rendered text content matches the manifest exactly (catches template
// escaping bugs) before writing the ground-truth JSON.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const manifest = JSON.parse(await readFile(new URL('../fixtures/phase2/manifest.json', import.meta.url), 'utf8'));
const browser = await chromium.launch();

const canonical = s => s.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();

await mkdir(new URL('../fixtures/phase2/ground-truth/', import.meta.url), { recursive: true });
let failures = 0;
for (const entry of manifest) {
  const context = await browser.newContext({
    viewport: { width: entry.referenceViewport.width, height: entry.referenceViewport.height },
    deviceScaleFactor: entry.referenceViewport.devicePixelRatio,
  });
  const page = await context.newPage();
  const url = new URL(`../fixtures/phase2/pages/${entry.id}.html`, import.meta.url).href;
  await page.goto(url);
  const measured = await page.$$eval('[data-gt-id]', nodes => nodes.map(node => {
    // getClientRects() gives one rect per visual line for an inline element -- the real,
    // rendered glyph extent, not the containing block's full width. getBoundingClientRect()
    // (the "box" below) is their union, kept as a convenience for single-line callers.
    // A <br> inside the span produces an extra zero-area rect for the line break itself in
    // some engines; drop zero-area rects since they cover no glyphs and aren't a redaction target.
    const rects = [...node.getClientRects()]
      .map(r => ({ x: r.x, y: r.y, width: r.width, height: r.height }))
      .filter(r => r.width > 0 && r.height > 0);
    const box = node.getBoundingClientRect();
    return {
      id: Number(node.getAttribute('data-gt-id')),
      category: node.getAttribute('data-gt-category'),
      renderedText: node.innerText,
      lineBoxes: rects,
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
    };
  }));
  const regions = entry.regions.map((r, i) => {
    const m = measured.find(x => x.id === i);
    if (!m) throw new Error(`${entry.id}: no rendered element for region ${i}`);
    if (canonical(m.renderedText) !== canonical(r.text)) {
      failures++;
      console.error(`MISMATCH ${entry.id}#${i}: rendered ${JSON.stringify(m.renderedText)} != manifest ${JSON.stringify(r.text)}`);
    }
    if (m.box.width <= 0 || m.box.height <= 0 || m.lineBoxes.length === 0) {
      failures++;
      console.error(`ZERO-AREA ${entry.id}#${i}: box ${JSON.stringify(m.box)}, lines ${m.lineBoxes.length}`);
    }
    const expectedLines = r.multiline ? 2 : 1;
    if (m.lineBoxes.length !== expectedLines) {
      failures++;
      console.error(`LINE-COUNT ${entry.id}#${i}: expected ${expectedLines} rendered line(s), got ${m.lineBoxes.length}`);
    }
    return {
      category: r.category, text: r.text, multiline: r.multiline ?? false,
      note: r.note, box: m.box, lineBoxes: m.lineBoxes,
    };
  });
  await writeFile(new URL(`../fixtures/phase2/ground-truth/${entry.id}.json`, import.meta.url), JSON.stringify({
    fixture: entry.id, set: entry.set, primaryCategory: entry.primaryCategory,
    hardNegative: entry.hardNegative, benign: entry.benign, tags: entry.tags,
    referenceViewport: entry.referenceViewport, fontPx: entry.fontPx, task: entry.task,
    regions,
  }, null, 2) + '\n');
  await context.close();
}
await browser.close();
if (failures > 0) { console.error(`${failures} measurement failure(s).`); process.exit(1); }
console.log(`Measured and wrote ground truth for ${manifest.length} fixtures.`);
