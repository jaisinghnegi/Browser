// Local-only sanitized preview: additive to Phase 1's existing full-withholding behavior, never
// a replacement for it. Nothing this module produces is ever sent anywhere -- background.ts's
// actual outbound payload (protocol 1, field-kind + opaque IDs only) is completely unchanged;
// this only builds an image kept in the popup's own memory for display, per the Phase 2 plan's
// "local original vs actually sanitized preview" UX goal, without opening protocol 2.
import { recognizeRegion, releaseRecognizer, RecognizerInputOverflowError } from './recognize';
import { classify } from './classify';

export interface TextRegion { text: string; boxes: Array<{ x: number; y: number; width: number; height: number }> }

export interface PreviewResult {
  // 'redacted': a preview image was built, with classified regions masked.
  // 'withheld': something made this preview untrustworthy to build at all (unsupported page
  //   structure the collector couldn't account for, or a recognition confidence/size below the
  //   reliable threshold) -- falls back to no preview, same conservative instinct as Phase 1's
  //   real fail-closed behavior, just for this local-only display rather than the outbound path.
  outcome: 'redacted' | 'withheld';
  withheldReason?: 'unsupported-structure' | 'uncertain-region' | 'too-many-regions'
    | 'region-too-wide' | 'time-budget-exceeded' | 'cancelled';
  redactedDataUrl: string | null;
  maskedRegionCount: number;
  uncertainRegionCount: number;
  timingMs: { recognize: number; total: number };
}

// Wall-clock ceiling for the whole preview build. Checked between regions -- it bounds how many
// more recognizer calls we start, NOT a running one: a synchronous onnxruntime-web WASM
// `session.run` cannot be preempted mid-call from this thread. On a real page with a few
// structural lines the whole build is well under this; hitting it means the environment is
// slower than the preview is worth blocking on, so withhold.
const MAX_PREVIEW_MS = 25_000;

// Physical pixels. Below this rendered line height, upscaling to the recognizer's required
// 48px input magnifies more than ~2.4x; fixtures/phase2/results' own tiny-text finding showed
// this degrades recognition enough that a resulting "no match" can't be trusted as "benign" --
// see docs/superpowers/plans/2026-09-08-phase2-detection-redaction.md and the phase2 detect.mjs
// commit history. A conservative minimum, not a per-fixture tuned value.
const MIN_RELIABLE_LINE_HEIGHT_PX = 20;
const MIN_CONFIDENCE = 0.5;
const MASK_MARGIN_PX = 10;
// Confirmed empirically, not just a theoretical worry: recognizing the real Phase 1 checkout
// fixture's structural lines in this actual packaged popup context took 60s+ at a cap of 24,
// and was inconsistent even at 16 (one run finished in ~18s, another still timed out) -- vs.
// the Node/Playwright evaluation harness's ~500ms/region average. Unthreaded in-browser WASM
// (`ort.env.wasm.proxy = false`, no worker) is measurably, substantially slower and apparently
// less predictable per call here than in that harness. 8 is a deliberately conservative bound
// chosen to make the common case reliably fast rather than to maximize preview coverage; the
// real checkout fixture lands in the withheld ("too-many-regions") outcome at this setting,
// which is an honest, safe result for this prototype, not a demo-friendly one. Root-causing
// and fixing the underlying per-call latency/variance (e.g. enabling the wasm proxy/worker,
// caching more aggressively across calls) is follow-up work, not done here.
const MAX_REGIONS = 8;

const canonical = (s: string) => s.replace(/\s+/g, ' ').trim();

export async function buildLocalPreview(
  screenshotDataUrl: string, regions: TextRegion[], devicePixelRatio: number,
  opts: { signal?: AbortSignal } = {},
): Promise<PreviewResult> {
  const start = performance.now();
  const { signal } = opts;
  const withheld = (reason: NonNullable<PreviewResult['withheldReason']>, recognize = 0): PreviewResult => ({
    outcome: 'withheld', withheldReason: reason, redactedDataUrl: null,
    maskedRegionCount: 0, uncertainRegionCount: 0,
    timingMs: { recognize, total: performance.now() - start },
  });
  if (!screenshotDataUrl.startsWith('data:image/png;base64,')) throw new Error('Invalid capture');
  const image = new Image();
  image.src = screenshotDataUrl;
  await image.decode();
  if (!image.naturalWidth || !image.naturalHeight) throw new Error('Empty capture');
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('No preview context');
  ctx.drawImage(image, 0, 0);

  // CSS-pixel boxes from the content script's DOM measurement, scaled to the physical-pixel
  // space the screenshot itself uses (captureVisibleTab captures device pixels).
  const lines = regions
    .flatMap(r => r.boxes.map(b => ({
      x: b.x * devicePixelRatio, y: b.y * devicePixelRatio,
      width: b.width * devicePixelRatio, height: b.height * devicePixelRatio,
    })))
    .sort((a, b) => a.y - b.y);

  if (signal?.aborted) return withheld('cancelled');
  if (lines.length > MAX_REGIONS) return withheld('too-many-regions');

  let uncertainRegionCount = 0;
  let tooWide = false;
  let cancelled = false;
  let timedOut = false;
  const recognized: Array<{ box: typeof lines[number]; text: string; category: string | null }> = [];
  const recognizeStart = performance.now();
  try {
    for (const box of lines) {
      // Between-region checks only: they bound how many more recognizer calls we start, not a
      // call already running (WASM session.run is not preemptible from here).
      if (signal?.aborted) { cancelled = true; break; }
      if (performance.now() - start > MAX_PREVIEW_MS) { timedOut = true; break; }
      if (box.height < MIN_RELIABLE_LINE_HEIGHT_PX) { uncertainRegionCount++; continue; }
      let rec;
      try {
        rec = await recognizeRegion(ctx, box);
      } catch (e) {
        if (e instanceof RecognizerInputOverflowError) { tooWide = true; break; }
        throw e;
      }
      if (rec.meanConfidence < MIN_CONFIDENCE) { uncertainRegionCount++; continue; }
      const text = canonical(rec.text);
      recognized.push({ box, text, category: classify(text) });
    }
  } finally {
    await releaseRecognizer();
  }
  const recognizeMs = performance.now() - recognizeStart;

  // A region we could not reliably read (too wide to recognize without horizontal squish)
  // withholds the whole preview -- it is never silently treated as "no PII here".
  if (tooWide) return withheld('region-too-wide', recognizeMs);
  if (cancelled) return withheld('cancelled', recognizeMs);
  if (timedOut) return withheld('time-budget-exceeded', recognizeMs);

  if (uncertainRegionCount > 0) {
    // Conservative: one unreliable region withholds the whole preview rather than shipping a
    // partially-confident mask -- the same all-or-nothing instinct as Phase 1's real contract,
    // applied here to what's shown locally, not just what's sent.
    return {
      outcome: 'withheld', withheldReason: 'uncertain-region', redactedDataUrl: null,
      maskedRegionCount: 0, uncertainRegionCount,
      timingMs: { recognize: recognizeMs, total: performance.now() - start },
    };
  }

  const maskedRegions = recognized.filter(r => r.category).map(r => r.box);
  ctx.fillStyle = '#000000';
  for (const box of maskedRegions) {
    ctx.fillRect(box.x - MASK_MARGIN_PX, box.y - MASK_MARGIN_PX, box.width + MASK_MARGIN_PX * 2, box.height + MASK_MARGIN_PX * 2);
  }
  const redactedDataUrl = canvas.toDataURL('image/png');
  return {
    outcome: 'redacted', redactedDataUrl, maskedRegionCount: maskedRegions.length, uncertainRegionCount: 0,
    timingMs: { recognize: recognizeMs, total: performance.now() - start },
  };
}
