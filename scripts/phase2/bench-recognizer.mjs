// Recognizer input-width cost profile. Corrected twice after review (ocr-profile-review,
// preview-lifecycle-review):
//   1. v1 measured oversized boxes over a 1000x800 screenshot; image-ops clips the crop to
//      naturalWidth, so 1400px and 2400px requests were the SAME tensor -- the "plateau" was
//      identical input. Withdrawn.
//   2. v2 timed "preprocess" as the whole Playwright evaluate, including Array.from(input)
//      serialization back to Node. That transport is not in the popup; its "preprocessing
//      dominates" conclusion was a harness artifact. Withdrawn.
//
// This version renders ONE real text line at a controlled CSS width in a wide viewport (crop
// fully in-bounds), times preprocessing INSIDE the page (just canvas draw + normalize loop)
// vs session.run/decode in Node, repeated samples, actual tensor dims. Finding: session.run is
// ~the entire cost (linear in width); in-page preprocess and decode are single-digit ms. It
// does NOT compare tiling (rejected: adds calls, risks a seam dropping a glyph -- production
// path is one inference with an explicit withhold above MAX_RECOGNIZER_WIDTH). These are Node
// numbers; the packaged popup is slower per call and still needs its own measurement.
//
// Not a privacy test and not part of the frozen evaluation -- pure performance instrumentation.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import * as ort from 'onnxruntime-web/wasm';
import { loadDictionary, ctcGreedyDecode } from './ctc.mjs';

const root = new URL('../../', import.meta.url);
const RECOGNIZER_HEIGHT = 48;
const SAMPLES = 5;

ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

const dictionary = await loadDictionary(fileURLToPath(new URL('models/text-recognizer-dictionary.txt', root)));
const recognizerBuf = await readFile(fileURLToPath(new URL('models/text-recognizer.onnx', root)));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 4200, height: 300 }, deviceScaleFactor: 1 });

async function renderLine(cssWidth) {
  const word = 'Baker Street Testville ';
  await page.setContent(
    `<div id="l" style="position:absolute;left:20px;top:40px;width:${cssWidth}px;white-space:nowrap;overflow:hidden;` +
    `font:22px/1.4 monospace;color:#111;background:#fff">221 ${word.repeat(80)}00000</div>`);
  const box = await page.$eval('#l', el => { const r = el.getClientRects()[0]; return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  const shot = await page.screenshot();
  return { box, dataUrl: `data:image/png;base64,${shot.toString('base64')}` };
}

const opsPage = await browser.newPage();
await opsPage.setContent('<canvas></canvas>');
// Returns the tensor AND a timer taken INSIDE the page for just the canvas draw + normalize
// loop (`inPagePreMs`). The wall time of this whole call additionally includes Playwright
// evaluate round-trip + `Array.from(input)` serialization/transport to Node -- that part is
// harness-only and absent in the real popup, so the two numbers are reported separately.
async function preprocess(dataUrl, box) {
  return opsPage.evaluate(async ({ dataUrl, box, H }) => {
    const image = new Image(); image.src = dataUrl; await image.decode();
    const x = Math.max(0, Math.floor(box.x)), y = Math.max(0, Math.floor(box.y));
    const w = Math.max(1, Math.min(image.naturalWidth - x, Math.ceil(box.width)));
    const h = Math.max(1, Math.min(image.naturalHeight - y, Math.ceil(box.height)));
    const tw = Math.max(8, Math.round(w * (H / h)));
    const t0 = performance.now();
    const c = document.createElement('canvas'); c.width = tw; c.height = H;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(image, x, y, w, h, 0, 0, tw, H);
    const rgba = cx.getImageData(0, 0, tw, H).data;
    const plane = tw * H; const input = new Float32Array(3 * plane);
    for (let ch = 0; ch < 3; ch++) for (let p = 0; p < plane; p++) input[ch * plane + p] = (rgba[p * 4 + (2 - ch)] / 255 - 0.5) / 0.5;
    const inPagePreMs = performance.now() - t0;
    return { tw, inPagePreMs, input: Array.from(input) };
  }, { dataUrl, box, H: RECOGNIZER_HEIGHT });
}

const session = await ort.InferenceSession.create(new Uint8Array(recognizerBuf), { executionProviders: ['wasm'] });
const median = a => a.slice().sort((x, y) => x - y)[a.length >> 1];

for (const cssWidth of [200, 600, 1200, 2400, 3600]) {
  const { box, dataUrl } = await renderLine(cssWidth);
  const preInPage = [], preHarness = [], inf = [], dec = [];
  let tw = 0, timesteps = 0;
  for (let i = 0; i < SAMPLES + 1; i++) {
    let t = performance.now();
    const p = await preprocess(dataUrl, box); tw = p.tw;
    const harnessPreMs = performance.now() - t; // includes evaluate round-trip + Array.from transport
    const tensor = new ort.Tensor('float32', Float32Array.from(p.input), [1, 3, RECOGNIZER_HEIGHT, tw]);
    t = performance.now();
    const out = await session.run({ [session.inputNames[0]]: tensor });
    const infMs = performance.now() - t;
    const o = out[session.outputNames[0]]; timesteps = o.dims[1];
    t = performance.now();
    ctcGreedyDecode(o.data, o.dims[1], o.dims[2], dictionary);
    const decMs = performance.now() - t;
    if (i > 0) { preInPage.push(p.inPagePreMs); preHarness.push(harnessPreMs); inf.push(infMs); dec.push(decMs); } // drop warm-up
  }
  console.log(
    `css ${String(cssWidth).padStart(4)}px | tensor ${tw}x${RECOGNIZER_HEIGHT} (${timesteps} steps) | ` +
    `preprocess in-page ${median(preInPage).toFixed(0)}ms (harness-inclusive ${median(preHarness).toFixed(0)}ms) | ` +
    `session.run ${median(inf).toFixed(0)}ms | decode ${median(dec).toFixed(1)}ms ` +
    `(n=${SAMPLES}, run min/max ${Math.min(...inf).toFixed(0)}/${Math.max(...inf).toFixed(0)})`);
}

await session.release();
await browser.close();
