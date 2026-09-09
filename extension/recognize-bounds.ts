// Pure recognizer-input bounds -- no onnxruntime/chrome imports, so this is unit-testable in a
// plain Node environment (tests/recognize-bounds.test.ts). recognize.ts re-exports these.

export const RECOGNIZER_HEIGHT = 48;

// Hard upper bound on the recognizer's input width, in pixels. The crop is drawn 1:1 in aspect
// (no horizontal squish), so below this bound there is no compression-induced misread; at or
// above it the region is withheld before inference rather than squished. Set generously so
// normal single-line field text at typical DPR never reaches it -- a memory/latency/pathology
// guard, not a routine path. See docs/plans/2026-09-09-preview-ocr-latency-profile.md.
export const MAX_RECOGNIZER_WIDTH = 4096;

/** Thrown when a region's aspect-preserving recognizer width would reach MAX_RECOGNIZER_WIDTH.
 * The region is NOT squished to fit and NOT recognized: a horizontally compressed crop can
 * produce a *confidently wrong* transcription that then misses PII classification, which a
 * meanConfidence check cannot catch. Callers must withhold, never treat it as benign. */
export class RecognizerInputOverflowError extends Error {
  constructor(public plannedWidth: number) { super('recognizer input width overflow'); }
}

/** Aspect-preserving width the recognizer crop would use, and whether that reaches the hard
 * bound above which the region must be withheld instead of recognized. */
export function planRecognizerInput(boxWidth: number, boxHeight: number): { targetWidth: number; overflow: boolean } {
  const w = Math.max(1, Math.ceil(boxWidth)), h = Math.max(1, Math.ceil(boxHeight));
  const targetWidth = Math.max(8, Math.round(w * (RECOGNIZER_HEIGHT / h)));
  return { targetWidth, overflow: targetWidth >= MAX_RECOGNIZER_WIDTH };
}
