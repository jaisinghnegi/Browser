import { describe, expect, it } from 'vitest';
import { resolveRegions, type Box } from '../extension/preview-regions';
import { RecognizerInputOverflowError } from '../extension/recognize-bounds';
import type { PreviewInterrupt } from '../extension/preview-gate';

const box = (over: Partial<Box> = {}): Box => ({ x: 0, y: 0, width: 200, height: 30, ...over });
const ok = (text: string, conf = 0.9) => async () => ({ text, meanConfidence: conf });
const never: () => PreviewInterrupt = () => null;
// interruptCheck fires: 1 initial + 1 before each region + 1 after the loop (only if still null)
const scripted = (seq: PreviewInterrupt[]) => { let i = 0; return () => seq[i++] ?? null; };

describe('resolveRegions', () => {
  it('recognises every region and classifies when nothing interrupts', async () => {
    const r = await resolveRegions(
      [box(), box({ y: 40 })],
      ok('14 Baker Rd, Testville 00000'),
      never,
    );
    expect(r.withheldReason).toBeNull();
    expect(r.recognized).toHaveLength(2);
    expect(r.recognized[0].category).toBe('address');
    expect(r.uncertainRegionCount).toBe(0);
  });

  it('WIRING: a deadline crossed only on the LAST inference still rejects (post-loop recheck)', async () => {
    // null for: initial + before region 1 + before region 2; then 'time-budget-exceeded' for
    // the post-loop check. If the post-loop recheck were removed this would resolve to null.
    const r = await resolveRegions(
      [box(), box({ y: 40 })],
      ok('benign text here'),
      scripted([null, null, null, 'time-budget-exceeded']),
    );
    expect(r.recognized).toHaveLength(2);          // both regions actually ran
    expect(r.withheldReason).toBe('time-budget-exceeded'); // ...and the result is still withheld
  });

  it('an abort before a region stops the pass and reports cancelled', async () => {
    const r = await resolveRegions(
      [box(), box({ y: 40 }), box({ y: 80 })],
      ok('benign'),
      scripted([null, null, 'cancelled']), // null init + null before region 1 + abort before region 2
    );
    expect(r.recognized).toHaveLength(1);
    expect(r.withheldReason).toBe('cancelled');
  });

  it('an oversized region withholds the whole pass, keeping earlier regions', async () => {
    let n = 0;
    const r = await resolveRegions(
      [box(), box({ y: 40 })],
      async () => {
        if (n++ === 0) return { text: 'ok', meanConfidence: 0.9 };
        throw new RecognizerInputOverflowError(9000);
      },
      never,
    );
    expect(r.recognized).toHaveLength(1);
    expect(r.withheldReason).toBe('region-too-wide');
  });

  it('a low-confidence region is counted uncertain, not classified', async () => {
    const r = await resolveRegions([box()], ok('14 Baker Rd, Testville 00000', 0.2), never);
    expect(r.recognized).toHaveLength(0);
    expect(r.uncertainRegionCount).toBe(1);
    expect(r.withheldReason).toBeNull();
  });

  it('a region below the reliable line height is skipped as uncertain without a recogniser call', async () => {
    let called = 0;
    const r = await resolveRegions(
      [box({ height: 8 })],
      async () => { called++; return { text: 'x', meanConfidence: 0.9 }; },
      never,
    );
    expect(called).toBe(0);
    expect(r.uncertainRegionCount).toBe(1);
  });
});
