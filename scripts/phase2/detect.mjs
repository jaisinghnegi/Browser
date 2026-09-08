// Local-only Phase 2 detection -> recognition -> classification -> masking pipeline, run
// against the frozen 44-fixture set. No extension/server code involved; no upload happens
// anywhere in this script. Produces fixtures/phase2/results/<id>.json (per-fixture pipeline
// output) and fixtures/phase2/results/<id>-redacted.png (the actual redacted bytes).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
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
const page = await openImageOpsPage();

async function runDetector(base64Png) {
  const pre = await loadAndPreprocessForDetector(page, base64Png);
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
  const pre = await cropAndPreprocessForRecognizer(page, base64Png, box);
  const tensor = new ort.Tensor('float32', Float32Array.from(pre.input), [1, 3, pre.targetHeight, pre.targetWidth]);
  const result = await recognizerSession.run({ [recognizerSession.inputNames[0]]: tensor });
  const output = result[recognizerSession.outputNames[0]];
  const [, timesteps, numClasses] = output.dims;
  return ctcGreedyDecode(output.data, timesteps, numClasses, dictionary);
}

const canonical = s => s.replace(/\s+/g, ' ').trim();

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
    const components = connectedComponents(det.mask, det.mapWidth, det.mapHeight);
    const lines = groupIntoLines(components);
    // Transform lines to full-resolution pixel space (per-axis factors -- Phase 2 plan §3's
    // correction: independent per-axis scale, not one nominal `scale`) before cropping/OCR,
    // so recognition and grouping both operate in real pixel space.
    const fullLines = lines
      .map(l => ({ x: l.x * det.scaleX, y: l.y * det.scaleY, width: l.width * det.scaleX, height: l.height * det.scaleY }))
      .filter(l => l.width > 2 && l.height > 2) // drop sub-pixel-scale noise, not "small text" -- see plan §3's min-area rule
      .sort((a, b) => a.y - b.y);

    // OCR every detected line individually -- this fixture set's uniform CSS spacing (every
    // region div uses the same margin) means adjacent-DOM-element gaps and unrelated-element
    // gaps aren't geometrically distinguishable, so grouping-by-proximity alone (tried first,
    // see git history) can't tell a split phone fragment from an unrelated form label sitting
    // at the same visual distance. Grouping is text-driven instead: classify each line alone,
    // then only merge adjacent lines when doing so is what makes classification succeed.
    const recognized = [];
    const recognizeStart = performance.now();
    for (const line of fullLines) {
      const rec = await runRecognizer(base64Png, expandBox(line, MASK_MARGIN_PX / 2));
      recognized.push({ box: line, text: canonical(rec.text), category: null, groupWith: null, annexed: false });
    }
    recognizeMs = performance.now() - recognizeStart;
    for (const r of recognized) r.category = classify(r.text);

    // Forward-merge pass: two adjacent, individually-unclassified lines whose concatenation
    // classifies are almost certainly one split entity (Phase 2 labeled-set spec §7's
    // split/groupId case) -- e.g. this set's own 5-char split phone fragments.
    for (let i = 0; i < recognized.length - 1; i++) {
      const a = recognized[i], b = recognized[i + 1];
      if (a.category || b.category || a.groupWith !== null || b.groupWith !== null) continue;
      const merged = classify(canonical(`${a.text} ${b.text}`));
      if (merged) { a.category = merged; a.groupWith = i + 1; b.groupWith = i; }
    }

    // Backward-annexation pass: a classified line's immediately preceding, still-unclaimed
    // line is masked along with it without needing its own text to classify -- this is how a
    // name directly above an address gets covered (Phase 2 plan §5: "a name adjacent to an
    // address block is address-block content, not a separately classified category"). Looking
    // backward only (never forward) is what keeps this from also annexing an unrelated
    // trailing label such as this fixture's "Shipping address" input caption.
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

    const redactedDataUrl = await drawRedactedImage(page, base64Png, maskedRegions);
    const redactedPng = Buffer.from(redactedDataUrl.split(',')[1], 'base64');
    await writeFile(fileURLToPath(new URL(`${entry.id}-redacted.png`, outDir)), redactedPng);

    outcome = {
      id: entry.id, status: 'processed', blocks: blockResults,
      maskedRegionCount: maskedRegions.length,
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
  console.log(`${entry.id}: ${outcome.status}${outcome.maskedRegionCount !== undefined ? ` (${outcome.maskedRegionCount} masked regions)` : ''}`);
}

await page.close();
await closeImageOps();
await writeFile(fileURLToPath(new URL('fixtures/phase2/results/pipeline-output.json', root)), JSON.stringify(results, null, 2) + '\n');
console.log(`\nProcessed ${results.length} fixtures: ${results.filter(r => r.status === 'processed').length} ok, ${results.filter(r => r.status === 'failed-closed').length} failed-closed.`);
