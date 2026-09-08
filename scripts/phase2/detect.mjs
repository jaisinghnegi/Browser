// Local-only Phase 2 detection -> recognition -> classification -> masking pipeline, run
// against the frozen 44-fixture set. No extension/server code involved; no upload happens
// anywhere in this script. Produces fixtures/phase2/results/<id>.json (per-fixture pipeline
// output) and fixtures/phase2/results/<id>-redacted.png (the actual redacted bytes).
//
// Architecture (revised): DOM structural text regions -- generic leaf elements with visible
// text, measured via getClientRects(), the exact same technique the ground-truth tooling uses
// -- are the PRIMARY source of "where is there text to check", not the vision detector's
// connected components. This is not GT-derived (no data-gt-*/labels/categories are read; only
// generic DOM structure -- any page would produce the same kind of list) and it fixes the
// class of failure "the detector never fired on this region at all" by construction: OCR/
// classification runs directly on every structural text region regardless of what the
// detector found there. The vision detector becomes a secondary cross-check: any detector
// component that does NOT overlap any structural region at all is content structure can't
// explain (e.g. canvas-rendered text) and is conservatively masked as "unresolved coverage"
// rather than ignored.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import * as ort from 'onnxruntime-web/wasm';
import { openImageOpsPage, closeImageOps, loadAndPreprocessForDetector, cropAndPreprocessForRecognizer, drawRedactedImage } from './image-ops.mjs';
import { connectedComponents, groupIntoLines, expandBox } from './geometry.mjs';
import { loadDictionary, ctcGreedyDecode } from './ctc.mjs';
import { classify } from './classify.mjs';

const root = new URL('../../', import.meta.url);
const DETECT_THRESHOLD = 0.3;
// Tuned against fixtures/phase2/tuning.json only (never holdout): the DB-style detector's
// probability-map boxes under-segment true glyph extent, especially vertically (cap-height/
// ascender area), by several px at this rendering size -- 4px left a ~3px gap versus measured
// ground truth on tuning samples; 10px closes it with margin to spare.
const MASK_MARGIN_PX = 10;
// A detector component must overlap SOME structural text box by at least this fraction of its
// own area to count as "explained by DOM structure"; below that, it's unresolved coverage.
const UNRESOLVED_OVERLAP_MIN_FRACTION = 0.1;

ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

const manifest = JSON.parse(await readFile(new URL('fixtures/phase2/manifest.json', root), 'utf8'));
const dictionary = await loadDictionary(fileURLToPath(new URL('models/text-recognizer-dictionary.txt', root)));
const detectorBuf = await readFile(fileURLToPath(new URL('models/text-detector.onnx', root)));
const recognizerBuf = await readFile(fileURLToPath(new URL('models/text-recognizer.onnx', root)));

let detectorSession, recognizerSession;
try {
  detectorSession = await ort.InferenceSession.create(new Uint8Array(detectorBuf), { executionProviders: ['wasm'] });
  recognizerSession = await ort.InferenceSession.create(new Uint8Array(recognizerBuf), { executionProviders: ['wasm'] });
} catch (e) {
  // Model load failure -> every fixture fails closed (fixture #2's "zero upload" contract:
  // no partial pipeline runs on a model that failed to load at all).
  console.error('FATAL: model load failed, all fixtures fail closed:', e.message);
  process.exit(1);
}

const outDir = new URL('fixtures/phase2/results/', root);
await mkdir(outDir, { recursive: true });
const opsPage = await openImageOpsPage();
const domBrowser = await chromium.launch();

/** Generic DOM structural query: every leaf element (no element children) with non-empty
 * rendered text, and its real per-line CSS layout boxes. Reads nothing but standard DOM APIs --
 * no data-gt- / label / category attributes exist on these clean pages at all. */
async function structuralTextBoxes(entry) {
  const context = await domBrowser.newContext({
    viewport: { width: entry.referenceViewport.width, height: entry.referenceViewport.height },
    deviceScaleFactor: entry.referenceViewport.devicePixelRatio,
  });
  const page = await context.newPage();
  await page.goto(new URL(`fixtures/phase2/pages/${entry.id}.html`, root).href);
  const leaves = await page.$$eval('body *', nodes => nodes
    .filter(el => el.children.length === 0 && el.textContent && el.textContent.trim().length > 0)
    .map(el => {
      const rects = [...el.getClientRects()]
        .map(r => ({ x: r.x, y: r.y, width: r.width, height: r.height }))
        .filter(r => r.width > 0 && r.height > 0);
      return { text: el.textContent.replace(/\s+/g, ' ').trim(), rects };
    })
    .filter(e => e.rects.length > 0));
  await context.close();
  const dpr = entry.referenceViewport.devicePixelRatio;
  // Scale CSS-pixel DOM boxes to physical-pixel screenshot space (matches the ground-truth
  // tooling's own convention -- see measure-phase2-fixtures.mjs).
  return leaves.map(l => ({
    text: l.text,
    lines: l.rects.map(r => ({ x: r.x * dpr, y: r.y * dpr, width: r.width * dpr, height: r.height * dpr })),
  }));
}

async function runDetector(base64Png) {
  const pre = await loadAndPreprocessForDetector(opsPage, base64Png);
  const tensor = new ort.Tensor('float32', Float32Array.from(pre.input), [1, 3, pre.height, pre.width]);
  const result = await detectorSession.run({ [detectorSession.inputNames[0]]: tensor });
  const output = result[detectorSession.outputNames[0]];
  if (output.type !== 'float32' || output.dims.length !== 4 || output.dims[0] !== 1 || output.dims[1] !== 1) {
    throw new Error('Invalid detector output shape');
  }
  const mapHeight = output.dims[2], mapWidth = output.dims[3];
  const data = output.data;
  for (const v of data) if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error('Invalid detector probability');
  const mask = new Uint8Array(mapWidth * mapHeight);
  for (let i = 0; i < mask.length; i++) mask[i] = data[i] > DETECT_THRESHOLD ? 1 : 0;
  return {
    mask, mapWidth, mapHeight,
    scaleX: pre.naturalWidth / pre.width, scaleY: pre.naturalHeight / pre.height,
    naturalWidth: pre.naturalWidth, naturalHeight: pre.naturalHeight,
  };
}

async function runRecognizer(base64Png, box) {
  const pre = await cropAndPreprocessForRecognizer(opsPage, base64Png, box);
  const tensor = new ort.Tensor('float32', Float32Array.from(pre.input), [1, 3, pre.targetHeight, pre.targetWidth]);
  const result = await recognizerSession.run({ [recognizerSession.inputNames[0]]: tensor });
  const output = result[recognizerSession.outputNames[0]];
  const [, timesteps, numClasses] = output.dims;
  return ctcGreedyDecode(output.data, timesteps, numClasses, dictionary);
}

const canonical = s => s.replace(/\s+/g, ' ').trim();
const boxArea = b => Math.max(0, b.width) * Math.max(0, b.height);
function overlapArea(a, b) {
  const x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return x * y;
}

const results = [];
for (const entry of manifest) {
  const pngBuf = await readFile(fileURLToPath(new URL(`fixtures/phase2/screenshots/${entry.id}.png`, root)));
  const base64Png = `data:image/png;base64,${pngBuf.toString('base64')}`;
  const fixtureStart = performance.now();
  let detectMs = 0, recognizeMs = 0;

  let outcome;
  try {
    const detectStart = performance.now();
    const det = await runDetector(base64Png);
    detectMs = performance.now() - detectStart;
    const components = connectedComponents(det.mask, det.mapWidth, det.mapHeight)
      .map(c => ({ x: c.x * det.scaleX, y: c.y * det.scaleY, width: c.width * det.scaleX, height: c.height * det.scaleY }))
      .filter(c => c.width > 2 && c.height > 2);

    const structural = await structuralTextBoxes(entry);
    // Flatten to one entry per rendered line (a multi-line leaf produces one entry per line,
    // exactly like the ground-truth tooling), sorted top-to-bottom.
    const structuralLines = structural.flatMap(s => s.lines.map(box => ({ box, sourceText: s.text })))
      .sort((a, b) => a.box.y - b.box.y);

    // OCR every structural line directly -- this is what fixes "the detector never fired on
    // this region" as a class, not just this fixture set's two known misses: recognition no
    // longer depends on the detector having proposed the crop location at all.
    const recognized = [];
    const recognizeStart = performance.now();
    for (const line of structuralLines) {
      const rec = await runRecognizer(base64Png, expandBox(line.box, MASK_MARGIN_PX / 2));
      recognized.push({ box: line.box, text: canonical(rec.text), category: null, groupWith: null, annexed: false });
    }
    recognizeMs = performance.now() - recognizeStart;
    for (const r of recognized) r.category = classify(r.text);

    // Forward-merge pass: two adjacent, individually-unclassified lines whose concatenation
    // classifies are almost certainly one split entity (Phase 2 labeled-set spec §7's
    // split/groupId case) -- e.g. this set's own 5-char split phone fragments. Tried both
    // space-joined and directly-joined: a fragment can already carry its own separator
    // character (e.g. a dashed phone split as "98888" / "-88889"), in which case inserting an
    // extra space produces two separator characters in a row and fails classification even
    // though the underlying value is intact.
    for (let i = 0; i < recognized.length - 1; i++) {
      const a = recognized[i], b = recognized[i + 1];
      if (a.category || b.category || a.groupWith !== null || b.groupWith !== null) continue;
      const merged = classify(canonical(`${a.text}${b.text}`)) ?? classify(canonical(`${a.text} ${b.text}`));
      if (merged) { a.category = merged; a.groupWith = i + 1; b.groupWith = i; }
    }

    // Backward-annexation pass: a classified line's immediately preceding, still-unclaimed
    // line is masked along with it without needing its own text to classify -- this is how a
    // name directly above an address gets covered (Phase 2 plan §5). Backward-only keeps this
    // from also annexing an unrelated trailing label.
    const ANNEX_MAX_GAP_PX = 40;
    for (let i = 0; i < recognized.length; i++) {
      if (!recognized[i].category || recognized[i].annexed) continue;
      const prev = recognized[i - 1];
      if (!prev || prev.category || prev.groupWith !== null || prev.annexed) continue;
      const gap = recognized[i].box.y - (prev.box.y + prev.box.height);
      if (gap >= 0 && gap <= ANNEX_MAX_GAP_PX) { prev.annexed = true; prev.groupWith = i; }
    }

    const maskedRegions = [];
    const blockResults = [];
    const reported = new Set();
    for (let i = 0; i < recognized.length; i++) {
      if (reported.has(i) || recognized[i].annexed) continue;
      const r = recognized[i];
      if (!r.category) {
        if (r.groupWith === null) blockResults.push({ box: r.box, text: r.text, category: null });
        continue; // an unclassified merge-partner (groupWith set, category null) is reported via its anchor.
      }
      const memberIdx = new Set([i]);
      if (r.groupWith !== null) memberIdx.add(r.groupWith);
      for (let k = 0; k < recognized.length; k++) if (recognized[k].groupWith === i) memberIdx.add(k);
      for (const idx of memberIdx) reported.add(idx);
      const members = [...memberIdx].map(idx => recognized[idx]).sort((x, y) => x.box.y - y.box.y);
      const x = Math.min(...members.map(m => m.box.x)), y = Math.min(...members.map(m => m.box.y));
      const maxX = Math.max(...members.map(m => m.box.x + m.box.width)), maxY = Math.max(...members.map(m => m.box.y + m.box.height));
      const maskBox = expandBox({ x, y, width: maxX - x, height: maxY - y }, MASK_MARGIN_PX);
      const text = members.map(m => m.text).join(' | ');
      blockResults.push({ box: maskBox, text, category: r.category, lineCount: members.length });
      maskedRegions.push(maskBox);
    }

    // Unresolved coverage: any vision-detected component structural DOM analysis can't explain
    // at all (no meaningful overlap with any structural text box) is content structure doesn't
    // account for -- e.g. canvas/shadow-DOM/generated content. Conservatively masked rather
    // than silently trusted as "not text" or silently trusted as "already handled elsewhere".
    const unresolvedRegions = [];
    for (const comp of components) {
      const compArea = boxArea(comp);
      if (compArea === 0) continue;
      const explained = structuralLines.some(l => overlapArea(comp, l.box) / compArea >= UNRESOLVED_OVERLAP_MIN_FRACTION);
      if (!explained) {
        const maskBox = expandBox(comp, MASK_MARGIN_PX);
        unresolvedRegions.push(maskBox);
        maskedRegions.push(maskBox);
      }
    }

    const redactedDataUrl = await drawRedactedImage(opsPage, base64Png, maskedRegions);
    const redactedPng = Buffer.from(redactedDataUrl.split(',')[1], 'base64');
    await writeFile(fileURLToPath(new URL(`${entry.id}-redacted.png`, outDir)), redactedPng);

    outcome = {
      id: entry.id, status: 'processed', blocks: blockResults,
      maskedRegionCount: maskedRegions.length,
      unresolvedCoverageRegionCount: unresolvedRegions.length,
      structuralLineCount: structuralLines.length,
      imageSize: { width: det.naturalWidth, height: det.naturalHeight },
      timingMs: { detect: detectMs, recognize: recognizeMs, total: performance.now() - fixtureStart },
    };
  } catch (e) {
    // Fail closed: no redacted image is written, no partial result -- equivalent to Phase 1's
    // "zero upload" contract when the vision stage can't be trusted.
    outcome = { id: entry.id, status: 'failed-closed', error: e.message,
      timingMs: { total: performance.now() - fixtureStart } };
  }
  results.push(outcome);
  console.log(`${entry.id}: ${outcome.status}${outcome.maskedRegionCount !== undefined ? ` (${outcome.maskedRegionCount} masked, ${outcome.unresolvedCoverageRegionCount} unresolved)` : ''}`);
}

await opsPage.close();
await closeImageOps();
await domBrowser.close();
await writeFile(fileURLToPath(new URL('fixtures/phase2/results/pipeline-output.json', root)), JSON.stringify(results, null, 2) + '\n');
console.log(`\nProcessed ${results.length} fixtures: ${results.filter(r => r.status === 'processed').length} ok, ${results.filter(r => r.status === 'failed-closed').length} failed-closed.`);
