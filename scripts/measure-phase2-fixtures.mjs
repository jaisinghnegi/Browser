// Measures real, rendered CSS layout-box bounds for each fixture's ground-truth regions --
// independent of any detector/model output, per the Phase 2 plan's requirement that ground
// truth be "positive measured CSS bounds", not authored/guessed coordinates. Also
// cross-checks that the rendered text content matches the manifest exactly (catches template
// escaping bugs) before writing anything.
//
// Reads from fixtures/phase2/pages-labeled/ (the only tree with data-gt-* attributes) --
// never from fixtures/phase2/pages/, which is the "real" fixture and deliberately carries no
// such attributes for any future detector-evaluation code to read as an answer key.
//
// Note on what's actually measured: getClientRects() returns the CSS inline *layout box*
// (line-box) for each rendered line -- font-metric-derived extent (ascent/descent/line-height),
// not a per-character glyph-ink bounding box. Real glyph ink can sit slightly inside this box
// depending on the font. This is the right ground truth for "does a redaction box drawn at
// this position cover the rendered line", which is what Phase 2's mask-coverage check needs;
// it is not a claim about exact per-glyph pixel extents. Rendering engine/version and the
// declared font stack are recorded per-run below so a re-measurement on a different
// browser/font environment can be diffed against this one rather than assumed identical.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const manifest = JSON.parse(await readFile(new URL('../fixtures/phase2/manifest.json', import.meta.url), 'utf8'));
const browser = await chromium.launch();
const renderer = { engine: 'chromium', version: browser.version() };

const canonical = s => s.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();

let failures = 0;
const toWrite = []; // Buffered: nothing is written to disk until every fixture has measured clean.

for (const entry of manifest) {
  const context = await browser.newContext({
    viewport: { width: entry.referenceViewport.width, height: entry.referenceViewport.height },
    deviceScaleFactor: entry.referenceViewport.devicePixelRatio,
  });
  const page = await context.newPage();
  const url = new URL(`../fixtures/phase2/pages-labeled/${entry.id}.html`, import.meta.url).href;
  await page.goto(url);
  const bodyFont = await page.$eval('body', b => getComputedStyle(b).fontFamily);
  const measured = await page.$$eval('[data-gt-id]', nodes => nodes.map(node => {
    // getClientRects() gives one rect per visual line for an inline element -- the real,
    // rendered layout-box extent, not the containing block's full width. getBoundingClientRect()
    // (the "box" below) is their union, kept as a convenience for single-line callers.
    // A <br> inside the span produces an extra zero-area rect for the line break itself in
    // some engines; drop zero-area rects since they cover no rendered content.
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
      note: r.note, groupId: r.groupId, fullText: r.fullText,
      box: m.box, lineBoxes: m.lineBoxes,
    };
  });
  toWrite.push({
    path: new URL(`../fixtures/phase2/ground-truth/${entry.id}.json`, import.meta.url),
    content: JSON.stringify({
      fixture: entry.id, set: entry.set, primaryCategory: entry.primaryCategory,
      hardNegative: entry.hardNegative, benign: entry.benign, tags: entry.tags,
      referenceViewport: entry.referenceViewport, fontPx: entry.fontPx, task: entry.task,
      renderer, computedFontFamily: bodyFont,
      regions,
    }, null, 2) + '\n',
  });
  await context.close();
}
await browser.close();

if (failures > 0) {
  console.error(`${failures} measurement failure(s). Nothing written -- frozen ground truth is untouched.`);
  process.exit(1);
}

await mkdir(new URL('../fixtures/phase2/ground-truth/', import.meta.url), { recursive: true });
for (const { path, content } of toWrite) await writeFile(path, content);
console.log(`Measured and wrote ground truth for ${manifest.length} fixtures.`);
