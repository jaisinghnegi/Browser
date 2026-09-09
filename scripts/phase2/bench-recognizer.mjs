// Recognizer input-width cost profile, corrected after review (ocr-profile-review).
//
// The earlier version measured synthetic oversized boxes over a 1000x800 screenshot;
// scripts/phase2/image-ops.mjs clips the source crop to `naturalWidth - x`, so both a 1400px
// and a 2400px request became the SAME ~2138-wide tensor -- the apparent "plateau" was just
// identical input, not a model-internal cap. Conclusions about internal caps and fixed
// per-call overhead were withdrawn.
//
// This version renders ONE real text line at a controlled CSS width in a wide viewport, so the
// crop is fully in-bounds, screenshots it, and measures preprocessing / session.run / decode
// separately with repeated samples. It reports actual tensor dimensions. It does NOT compare a
// tiling strategy (tiling was rejected: it adds calls and risks a seam dropping a glyph -> the
// production path is a single inference with an explicit withhold above MAX_RECOGNIZER_WIDTH,
// see extension/recognize-bounds.ts).
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
async function preprocess(dataUrl, box) {
  return opsPage.evaluate(async ({ dataUrl, box, H }) => {
    const image = new Image(); image.src = dataUrl; await image.decode();
    const x = Math.max(0, Math.floor(box.x)), y = Math.max(0, Math.floor(box.y));
    const w = Math.max(1, Math.min(image.naturalWidth - x, Math.ceil(box.width)));
    const h = Math.max(1, Math.min(image.naturalHeight - y, Math.ceil(box.height)));
    const tw = Math.max(8, Math.round(w * (H / h)));
    const c = document.createElement('canvas'); c.width = tw; c.height = H;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(image, x, y, w, h, 0, 0, tw, H);
    const rgba = cx.getImageData(0, 0, tw, H).data;
    const plane = tw * H; const input = new Float32Array(3 * plane);
    for (let ch = 0; ch < 3; ch++) for (let p = 0; p < plane; p++) input[ch * plane + p] = (rgba[p * 4 + (2 - ch)] / 255 - 0.5) / 0.5;
    return { tw, input: Array.from(input) };
  }, { dataUrl, box, H: RECOGNIZER_HEIGHT });
}

const session = await ort.InferenceSession.create(new Uint8Array(recognizerBuf), { executionProviders: ['wasm'] });
const median = a => a.slice().sort((x, y) => x - y)[a.length >> 1];

for (const cssWidth of [200, 600, 1200, 2400, 3600]) {
  const { box, dataUrl } = await renderLine(cssWidth);
  const pre = [], inf = [], dec = [];
  let tw = 0, timesteps = 0;
  for (let i = 0; i < SAMPLES + 1; i++) {
    let t = performance.now();
    const p = await preprocess(dataUrl, box); tw = p.tw;
    const preMs = performance.now() - t;
    const tensor = new ort.Tensor('float32', Float32Array.from(p.input), [1, 3, RECOGNIZER_HEIGHT, tw]);
    t = performance.now();
    const out = await session.run({ [session.inputNames[0]]: tensor });
    const infMs = performance.now() - t;
    const o = out[session.outputNames[0]]; timesteps = o.dims[1];
    t = performance.now();
    ctcGreedyDecode(o.data, o.dims[1], o.dims[2], dictionary);
    const decMs = performance.now() - t;
    if (i > 0) { pre.push(preMs); inf.push(infMs); dec.push(decMs); } // drop warm-up
  }
  console.log(
    `css ${String(cssWidth).padStart(4)}px | tensor ${tw}x${RECOGNIZER_HEIGHT} (${timesteps} steps) | ` +
    `preprocess ${median(pre).toFixed(0)}ms | session.run ${median(inf).toFixed(0)}ms | decode ${median(dec).toFixed(1)}ms ` +
    `(n=${SAMPLES}, min/max run ${Math.min(...inf).toFixed(0)}/${Math.max(...inf).toFixed(0)})`);
}

await session.release();
await browser.close();
