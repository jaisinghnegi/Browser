// Local-only preview recognizer: a direct TypeScript port of scripts/phase2/ctc.mjs's decode
// contract, run against the pinned PP-OCRv4 recognizer confirmed in models/README.md. This
// module never sends anything anywhere -- it only decodes model output already computed
// on-device into a string kept in memory.
import * as ort from 'onnxruntime-web/wasm';
import { RECOGNIZER_HEIGHT, planRecognizerInput, RecognizerInputOverflowError } from './recognize-bounds';
export { planRecognizerInput, RecognizerInputOverflowError } from './recognize-bounds';

// Set here too, defensively -- vision.ts also sets these (and both modules share the same
// bundled ort instance in popup.js), but recognize.ts must not depend on call-order luck with
// a different module to be configured correctly.
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = chrome.runtime.getURL('vendor/');
ort.env.logLevel = 'error';

export interface RecognizeResult { text: string; meanConfidence: number }

let dictionary: string[] | undefined;

export async function loadDictionary(): Promise<string[]> {
  if (dictionary) return dictionary;
  const text = await (await fetch(chrome.runtime.getURL('models/text-recognizer-dictionary.txt'))).text();
  dictionary = text.split(/\r?\n/).filter(line => line.length > 0);
  return dictionary;
}

/** CTC greedy decode: class 0 = blank, classes 1..N = dictionary in order, class N+1 = the
 * trailing space class PaddleOCR appends (matches models/README.md's confirmed I/O). */
export function ctcGreedyDecode(probs: Float32Array, timesteps: number, numClasses: number, dict: string[]): RecognizeResult {
  let prev = -1;
  const chars: string[] = [];
  const confidences: number[] = [];
  for (let t = 0; t < timesteps; t++) {
    let best = 0, bestP = -Infinity;
    for (let c = 0; c < numClasses; c++) {
      const p = probs[t * numClasses + c];
      if (p > bestP) { bestP = p; best = c; }
    }
    if (best !== 0 && best !== prev) {
      chars.push(best === numClasses - 1 ? ' ' : (dict[best - 1] ?? ''));
      confidences.push(bestP);
    }
    prev = best;
  }
  const text = chars.join('');
  const meanConfidence = confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0;
  return { text, meanConfidence };
}

/** One recognizer session owned by ONE preview build. Not a module-global: overlapping builds
 * (a supersede lands mid-inference) must not share a session or race each other's cleanup --
 * each build creates its own and releases only its own, in its own `finally`. */
export class RecognizerSession {
  private constructor(private session: ort.InferenceSession, private dict: string[]) {}

  static async create(): Promise<RecognizerSession> {
    const dict = await loadDictionary();
    const session = await ort.InferenceSession.create(
      chrome.runtime.getURL('models/text-recognizer.onnx'), { executionProviders: ['wasm'] });
    return new RecognizerSession(session, dict);
  }

  /** Crops `box` (physical-pixel coords in the already-decoded source canvas) and runs the
   * recognizer. Reads pixels only; never persists them beyond the one-call Float32Array. */
  async recognizeRegion(
    ctx: CanvasRenderingContext2D, box: { x: number; y: number; width: number; height: number },
  ): Promise<RecognizeResult> {
    const x = Math.max(0, Math.floor(box.x)), y = Math.max(0, Math.floor(box.y));
    const w = Math.max(1, Math.ceil(box.width)), h = Math.max(1, Math.ceil(box.height));
    const targetHeight = RECOGNIZER_HEIGHT;
    const { targetWidth, overflow } = planRecognizerInput(box.width, box.height);
    if (overflow) throw new RecognizerInputOverflowError(targetWidth);
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = targetWidth; cropCanvas.height = targetHeight;
    const cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true });
    if (!cropCtx) throw new Error('No crop context');
    cropCtx.drawImage(ctx.canvas, x, y, w, h, 0, 0, targetWidth, targetHeight);
    const rgba = cropCtx.getImageData(0, 0, targetWidth, targetHeight).data;
    const plane = targetWidth * targetHeight;
    const input = new Float32Array(3 * plane);
    for (let c = 0; c < 3; c++) for (let p = 0; p < plane; p++) {
      input[c * plane + p] = (rgba[p * 4 + (2 - c)] / 255 - 0.5) / 0.5;
    }
    const result = await this.session.run({
      [this.session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, targetHeight, targetWidth]),
    });
    const output = result[this.session.outputNames[0]];
    const [, timesteps, numClasses] = output.dims;
    input.fill(0);
    return ctcGreedyDecode(output.data as Float32Array, timesteps, numClasses, this.dict);
  }

  async release(): Promise<void> { await this.session.release(); }
}
