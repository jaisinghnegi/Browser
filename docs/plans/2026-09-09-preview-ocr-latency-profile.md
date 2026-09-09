# Local preview OCR latency — profiling notes (2026-09-09)

Context: the in-popup sanitized-preview recognizer (`extension/recognize.ts` +
`extension/preview.ts`) was measured last session at 60s+ for the Phase 1 checkout
fixture, landing that fixture in the `withheld ("too-many-regions")` state at
`MAX_REGIONS = 8`. This is the "profile before optimizing" pass Astra asked for.

## Hypothesis tested: unbounded recognizer input width

The recognizer resizes each crop to height 48 preserving aspect, so a wide DOM line
becomes a very wide tensor (`width = w * 48 / h`). Hypothesis: that oversized width is
the dominant cost, and splitting wide lines into ≤320px tiles (the upstream PP-OCRv4
eval width) would bound it.

### Measurement — `scripts/phase2/bench-recognizer.mjs`

Same crop, one inference vs. N×≤320px tiles, `onnxruntime-web` wasm, `numThreads=1`,
RTX 4060 laptop. Synthetic page-wide box over a real fixture screenshot:

| box width | single inference | tiled (N tiles) | tiled / single |
|-----------|------------------|-----------------|----------------|
| 400 px    | ~1.2 s           | ~1.4 s (3)      | 1.12x          |
| 800 px    | ~2.6 s           | ~2.8 s (6)      | 1.10x          |
| 1400 px   | ~3.1 s           | ~4.6 s (10)     | 1.48x          |
| 2400 px   | ~3.1 s           | ~8.1 s (17)     | 2.59x          |

### Conclusion

Tiling is the **wrong lever**. A single wide inference is *sublinear* in width and
plateaus (~3.1 s — the recognizer graph caps internal width near ~2100 px), while N
fixed-width tiles cost linearly in tile count because per-inference fixed overhead
(tensor alloc, `session.run` dispatch, preprocessing round-trip) dominates. Tiling
would also risk a tile seam dropping a glyph → under-masking.

**Kept instead** (`extension/recognize.ts`): a single inference with an absolute
`MAX_RECOGNIZER_WIDTH = 2048` clamp — only a guard against a pathological DOM leaf
allocating an enormous tensor; it never triggers on normal content and the value sits
on the model's own internal plateau, so it is effectively free. Also moved the
`ort.env.wasm` config (`numThreads=1`, `proxy=false`, `wasmPaths`, `logLevel`) into
this module so it does not depend on `vision.ts` running first.

## Where the cost actually is

- **Detector**, not recognizer: `scripts/phase2/detect.mjs` aggregate over the frozen
  44-set is detect mean ~8.3 s / fixture vs. recognize mean ~0.9 s / fixture.
- **In-popup per-call is ~3–5x the Node-harness per-call** (unthreaded WASM in the MV3
  popup, no SIMD/worker). 60s ≈ ~24 regions × ~2.5 s. The cost scales with region
  *count*, already bounded by `MAX_REGIONS = 8`.

## Next optimization to evaluate (not done here)

Batched inference: pad the ≤8 line-crops to a common width and run one
`[N,3,48,W]` call instead of N calls, collapsing per-call overhead. Needs an
accuracy check (padding) and a memory check. Bounded, but its own chunk.
