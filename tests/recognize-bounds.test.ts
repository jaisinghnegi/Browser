import { describe, expect, it } from 'vitest';
import { planRecognizerInput, RecognizerInputOverflowError, MAX_RECOGNIZER_WIDTH, RECOGNIZER_HEIGHT } from '../extension/recognize-bounds';

describe('recognizer input bounds', () => {
  it('preserves aspect for a normal single-line field box', () => {
    // ~600px wide, ~28px tall line -> scaled to height 48
    const { targetWidth, overflow } = planRecognizerInput(600, 28);
    expect(overflow).toBe(false);
    expect(targetWidth).toBe(Math.round(600 * (RECOGNIZER_HEIGHT / 28)));
  });

  it('does not overflow just below the hard bound', () => {
    // pick a box whose scaled width lands just under MAX_RECOGNIZER_WIDTH
    const h = 20;
    const w = Math.floor((MAX_RECOGNIZER_WIDTH - 1) * h / RECOGNIZER_HEIGHT) - 1;
    expect(planRecognizerInput(w, h).overflow).toBe(false);
  });

  it('flags overflow at/above the hard bound instead of silently squishing', () => {
    const h = 20;
    const w = Math.ceil(MAX_RECOGNIZER_WIDTH * h / RECOGNIZER_HEIGHT) + 50;
    const { targetWidth, overflow } = planRecognizerInput(w, h);
    expect(overflow).toBe(true);
    expect(targetWidth).toBeGreaterThanOrEqual(MAX_RECOGNIZER_WIDTH);
  });

  it('a very wide line (e.g. 8000px CSS at dpr 1) overflows and must be withheld, not read', () => {
    expect(planRecognizerInput(8000, 30).overflow).toBe(true);
  });

  it('RecognizerInputOverflowError carries the planned width and is identifiable', () => {
    const e = new RecognizerInputOverflowError(9001);
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(RecognizerInputOverflowError);
    expect(e.plannedWidth).toBe(9001);
  });
});
