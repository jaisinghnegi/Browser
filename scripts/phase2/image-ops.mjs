// Canvas-based pixel operations, run inside a real (headless) Chromium page via Playwright --
// reused rather than adding a new native image-processing dependency, and deliberately mirrors
// extension/vision.ts's own decode/resize/normalize approach so this local prototype's
// preprocessing matches what the real extension does.
import { chromium } from 'playwright';

let browserPromise;
async function getBrowser() {
  browserPromise ??= chromium.launch();
  return browserPromise;
}

/** One long-lived page used for all image ops in a run; avoids relaunching a browser per call. */
export async function openImageOpsPage() {
  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setContent('<canvas id="c"></canvas>');
  return page;
}

export async function closeImageOps() {
  if (browserPromise) await (await browserPromise).close();
}

/** Loads a PNG (base64) and returns its natural size plus a detector-ready tensor, matching
 * vision.ts: max side 640, dims rounded to multiples of 32, BGR planar float32, ImageNet
 * mean/std. Returns the actual resized width/height too, since independent per-axis rounding
 * means they aren't derivable from a single nominal scale factor (Phase 2 plan §3). */
export async function loadAndPreprocessForDetector(page, base64Png) {
  return page.evaluate(async (dataUrl) => {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    const naturalWidth = image.naturalWidth, naturalHeight = image.naturalHeight;
    const scale = Math.min(1, 640 / Math.max(naturalWidth, naturalHeight));
    const width = Math.max(32, Math.round(naturalWidth * scale / 32) * 32);
    const height = Math.max(32, Math.round(naturalHeight * scale / 32) * 32);
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, width, height);
    const rgba = ctx.getImageData(0, 0, width, height).data;
    const plane = width * height;
    const input = new Float32Array(3 * plane);
    const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
    for (let c = 0; c < 3; c++) for (let p = 0; p < plane; p++) {
      input[c * plane + p] = (rgba[p * 4 + (2 - c)] / 255 - mean[c]) / std[c];
    }
    return { naturalWidth, naturalHeight, width, height, input: Array.from(input) };
  }, base64Png);
}

/** Crops a region (in original/full-resolution pixel space) from the full image, resizes to
 * fixed height 48 preserving aspect ratio (the recognizer's confirmed input contract -- see
 * models/README.md), and returns a BGR [-1,1]-normalized tensor plus the crop's pixel width. */
export async function cropAndPreprocessForRecognizer(page, base64Png, box) {
  return page.evaluate(async ({ dataUrl, box }) => {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    const x = Math.max(0, Math.floor(box.x)), y = Math.max(0, Math.floor(box.y));
    const w = Math.max(1, Math.min(image.naturalWidth - x, Math.ceil(box.width)));
    const h = Math.max(1, Math.min(image.naturalHeight - y, Math.ceil(box.height)));
    const targetHeight = 48;
    const targetWidth = Math.max(8, Math.round(w * (targetHeight / h)));
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth; canvas.height = targetHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, x, y, w, h, 0, 0, targetWidth, targetHeight);
    const rgba = ctx.getImageData(0, 0, targetWidth, targetHeight).data;
    const plane = targetWidth * targetHeight;
    const input = new Float32Array(3 * plane);
    for (let c = 0; c < 3; c++) for (let p = 0; p < plane; p++) {
      input[c * plane + p] = (rgba[p * 4 + (2 - c)] / 255 - 0.5) / 0.5;
    }
    return { targetWidth, targetHeight, input: Array.from(input) };
  }, { dataUrl: base64Png, box });
}

/** Draws opaque redaction boxes (full alpha, fixed color) directly into a fresh re-encode of
 * the original image and returns the redacted PNG as a data URL -- the actual bytes an upload
 * would carry, not a CSS overlay over the original. */
export async function drawRedactedImage(page, base64Png, boxes) {
  return page.evaluate(async ({ dataUrl, boxes }) => {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    ctx.fillStyle = '#000000';
    for (const b of boxes) ctx.fillRect(b.x, b.y, b.width, b.height);
    return canvas.toDataURL('image/png');
  }, { dataUrl: base64Png, boxes });
}

/** Reads back only the pixels inside one region of the (redacted) image, so the evaluation
 * harness can verify opacity/coverage directly against ground truth without transferring an
 * entire full-resolution image's pixel array for every check. */
export async function readImageRegionPixels(page, base64Png, box) {
  return page.evaluate(async ({ dataUrl, box }) => {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    const x = Math.max(0, Math.floor(box.x)), y = Math.max(0, Math.floor(box.y));
    const w = Math.max(1, Math.min(image.naturalWidth - x, Math.ceil(box.width)));
    const h = Math.max(1, Math.min(image.naturalHeight - y, Math.ceil(box.height)));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, x, y, w, h, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    return { width: w, height: h, data: Array.from(data) };
  }, { dataUrl: base64Png, box });
}
