import { describe, expect, it } from 'vitest';
import { evaluatePreviewInterrupt } from '../extension/preview-gate';

describe('preview interrupt gate', () => {
  it('no interrupt while within budget and not aborted', () => {
    expect(evaluatePreviewInterrupt(false, 1000, 25_000)).toBeNull();
  });

  it('abort takes precedence over the budget', () => {
    expect(evaluatePreviewInterrupt(true, 10, 25_000)).toBe('cancelled');
    expect(evaluatePreviewInterrupt(true, 999_999, 25_000)).toBe('cancelled');
  });

  it('elapsed strictly over the deadline is time-budget-exceeded', () => {
    expect(evaluatePreviewInterrupt(false, 25_001, 25_000)).toBe('time-budget-exceeded');
  });

  it('elapsed exactly at the deadline is not yet exceeded', () => {
    expect(evaluatePreviewInterrupt(false, 25_000, 25_000)).toBeNull();
  });

  it('a single region crossing a tiny deadline is rejected (last-inference overrun case)', () => {
    // buildLocalPreview calls this again AFTER the final awaited recognition; a lone slow call
    // that overran a 1ms budget must still reject rather than publish.
    expect(evaluatePreviewInterrupt(false, 5, 1)).toBe('time-budget-exceeded');
  });
});
