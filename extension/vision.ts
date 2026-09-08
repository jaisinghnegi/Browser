import * as ort from 'onnxruntime-web/wasm';

export interface VisionResult { milliseconds: number; textPixels: number; width: number; height: number }

/** Raw pixels remain in this extension document. No image is returned to the planner. */
export async function inspectScreenshot(dataUrl: string): Promise<VisionResult> {
  if (!dataUrl.startsWith('data:image/png;base64,')) throw new Error('Invalid capture');
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = chrome.runtime.getURL('vendor/');
  ort.env.logLevel = 'error';
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  if (!image.naturalWidth || !image.naturalHeight) throw new Error('Empty capture');
  const scale = Math.min(1, 640 / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(32, Math.round(image.naturalWidth * scale / 32) * 32);
  const height = Math.max(32, Math.round(image.naturalHeight * scale / 32) * 32);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('No image context');
  ctx.drawImage(image, 0, 0, width, height);
  image.src = '';
  const rgba = ctx.getImageData(0, 0, width, height).data;
  // Erase the scratch canvas as soon as preprocessing has read its pixels.
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, width, height);
  const plane = width * height;
  const input = new Float32Array(3 * plane);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  for (let c = 0; c < 3; c++) for (let p = 0; p < plane; p++) {
    input[c * plane + p] = (rgba[p * 4 + (2 - c)] / 255 - mean[c]) / std[c];
  }
  rgba.fill(0);
  let session: ort.InferenceSession | undefined;
  try {
    session = await ort.InferenceSession.create(chrome.runtime.getURL('models/text-detector.onnx'), { executionProviders: ['wasm'] });
    const start = performance.now();
    const result = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, height, width]) });
    const milliseconds = performance.now() - start;
    const output = result[session.outputNames[0]];
    if (output.type !== 'float32' || output.dims.length !== 4 || output.dims[0] !== 1 || output.dims[1] !== 1) {
      throw new Error('Invalid model output');
    }
    let textPixels = 0;
    for (const value of output.data as Float32Array) {
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Invalid probability');
      if (value > 0.3) textPixels++;
    }
    if (textPixels < 8) throw new Error('No confident text region');
    return { milliseconds, textPixels, width: output.dims[3], height: output.dims[2] };
  } finally {
    input.fill(0);
    if (session) await session.release();
  }
}
