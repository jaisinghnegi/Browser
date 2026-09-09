// Focused before/after latency measurement for the recognizer input-width question. The frozen
// 44-fixture set has only short single-field lines, so any width strategy looks identical in
// detect.mjs's aggregate numbers. This isolates the WIDE-line case that motivated the concern
// (the Phase 1 checkout page's long structural lines, reported at 60s+ in-browser): it runs the
// SAME crop as one inference vs. as >=320px horizontal tiles, on a synthetic wide box over a
// real fixture screenshot, and prints wall-clock for each.
//
// Result (RTX 4060 laptop, onnxruntime-web wasm, numThreads=1): a single wide inference is
// SUBLINEAR in width and plateaus (the recognizer graph caps internal width near ~2100px),
// while N fixed-320px tiles are strictly slower -- per-inference fixed overhead dominates and
// grows linearly with tile count. So tiling is the wrong lever for latency; detect.mjs keeps a
// single inference with an absolute width clamp only. See extension/recognize.ts.
//
// Not a privacy test and not part of the frozen evaluation -- pure performance instrumentation.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web/wasm';
import { openImageOpsPage, closeImageOps, cropAndPreprocessForRecognizer } from './image-ops.mjs';

const root = new URL('../../', import.meta.url);
const MAX_RECOGNIZER_WIDTH = 320;
const TILE_OVERLAP_PX = 16;
const RECOGNIZER_HEIGHT = 48;

ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

const recognizerBuf = await readFile(fileURLToPath(new URL('models/text-recognizer.onnx', root)));
const session = await ort.InferenceSession.create(new Uint8Array(recognizerBuf), { executionProviders: ['wasm'] });
const page = await openImageOpsPage();

const pngBuf = await readFile(fileURLToPath(new URL('fixtures/phase2/screenshots/address-tuning-00.png', root)));
const base64Png = `data:image/png;base64,${pngBuf.toString('base64')}`;

async function runOneCrop(box, forceTargetWidth) {
  const pre = await cropAndPreprocessForRecognizer(page, base64Png, box, forceTargetWidth);
  const tensor = new ort.Tensor('float32', Float32Array.from(pre.input), [1, 3, pre.targetHeight, pre.targetWidth]);
  const result = await session.run({ [session.inputNames[0]]: tensor });
  result[session.outputNames[0]].dispose?.();
  return { targetWidth: pre.targetWidth };
}

async function single(box) {
  const t = performance.now();
  const r = await runOneCrop(box);
  return { ms: performance.now() - t, width: r.targetWidth };
}

async function tiled(box) {
  const t = performance.now();
  const h = Math.max(1, Math.ceil(box.height));
  const scale = RECOGNIZER_HEIGHT / h;
  const fullWidth = Math.max(8, Math.round(Math.ceil(box.width) * scale));
  const tileCount = Math.ceil(fullWidth / MAX_RECOGNIZER_WIDTH);
  const srcTileW = box.width / tileCount;
  const widths = [];
  for (let i = 0; i < tileCount; i++) {
    const lead = i > 0 ? TILE_OVERLAP_PX : 0;
    const sx = Math.max(box.x, box.x + i * srcTileW - lead);
    const sw = Math.ceil(srcTileW) + lead;
    const tw = Math.max(8, Math.min(MAX_RECOGNIZER_WIDTH, Math.round(sw * scale)));
    const r = await runOneCrop({ x: sx, y: box.y, width: sw, height: box.height }, tw);
    widths.push(r.targetWidth);
  }
  return { ms: performance.now() - t, tileCount, widths };
}

for (const w of [400, 800, 1400, 2400]) {
  const box = { x: 20, y: 40, width: w, height: 22 };
  await single(box); await tiled(box); // warm
  const sMs = Math.min((await single(box)).ms, (await single(box)).ms);
  const t1 = await tiled(box);
  const tMs = Math.min(t1.ms, (await tiled(box)).ms);
  console.log(`box ${w}px | single ${sMs.toFixed(0)}ms | tiled ${tMs.toFixed(0)}ms (${t1.tileCount} tiles) | tiled is ${(tMs / sMs).toFixed(2)}x the single-call time`);
}

await page.close();
await closeImageOps();
await session.release();
