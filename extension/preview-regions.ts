// The preview recogniser loop + every fail-closed check, extracted with NO canvas / model /
// chrome imports so it is unit-testable in plain Node (tests/preview-regions.test.ts) with an
// injected `recognize` and `interruptCheck`. buildLocalPreview (preview.ts) wires the real
// per-build RecognizerSession and clock into it.
import type { RecognizeResult } from './recognize';
import { RecognizerInputOverflowError } from './recognize-bounds';
import type { PreviewInterrupt } from './preview-gate';
import { classify } from './classify';

export type Box = { x: number; y: number; width: number; height: number };
export type RecognizedRegion = { box: Box; text: string; category: string | null };

// Physical pixels. Below this rendered line height, upscaling to the recognizer's 48px input
// magnifies >~2.4x and degrades recognition enough that a resulting "no match" can't be
// trusted as "benign" (fixtures/phase2 tiny-text finding). A conservative minimum.
export const MIN_RELIABLE_LINE_HEIGHT_PX = 20;
export const MIN_CONFIDENCE = 0.5;

export const canonical = (s: string) => s.replace(/\s+/g, ' ').trim();

export type RegionPassResult = {
  recognized: RecognizedRegion[];
  uncertainRegionCount: number;
  /** null => proceed to draw; otherwise the whole preview is withheld for this reason and NO
   * image is produced. */
  withheldReason: 'region-too-wide' | PreviewInterrupt;
};

/** `interruptCheck` is called before each region AND once more after the final awaited
 * recognition -- a last call (or an abort landing during it) that crossed the budget rejects
 * here; it does not fall through to publish. */
export async function resolveRegions(
  lines: Box[],
  recognize: (box: Box) => Promise<RecognizeResult>,
  interruptCheck: () => PreviewInterrupt,
  cfg: { minHeightPx: number; minConfidence: number } = { minHeightPx: MIN_RELIABLE_LINE_HEIGHT_PX, minConfidence: MIN_CONFIDENCE },
): Promise<RegionPassResult> {
  const recognized: RecognizedRegion[] = [];
  let uncertainRegionCount = 0;
  let interrupt: PreviewInterrupt = interruptCheck();
  for (const box of lines) {
    interrupt = interruptCheck();
    if (interrupt) break;
    if (box.height < cfg.minHeightPx) { uncertainRegionCount++; continue; }
    let rec: RecognizeResult;
    try {
      rec = await recognize(box);
    } catch (e) {
      if (e instanceof RecognizerInputOverflowError) {
        return { recognized, uncertainRegionCount, withheldReason: 'region-too-wide' };
      }
      throw e;
    }
    if (rec.meanConfidence < cfg.minConfidence) { uncertainRegionCount++; continue; }
    const text = canonical(rec.text);
    recognized.push({ box, text, category: classify(text) });
  }
  interrupt = interrupt || interruptCheck();
  return { recognized, uncertainRegionCount, withheldReason: interrupt };
}
