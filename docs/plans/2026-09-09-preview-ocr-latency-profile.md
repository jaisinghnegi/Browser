# Local preview OCR latency — profiling notes (2026-09-09)

Context: the in-popup sanitized-preview recognizer (`extension/recognize.ts` +
`extension/preview.ts`) was measured last session at 60s+ for the Phase 1 checkout
fixture, landing that fixture in a `withheld` state at `MAX_REGIONS = 8`. This is the
"profile before optimizing" pass.

## Correction to the first attempt

The first benchmark measured synthetic oversized boxes over a 1000×800 screenshot.
`scripts/phase2/image-ops.mjs` clips the source crop to `naturalWidth - x`, so a
1400px and a 2400px request both became the **same** ~2138-wide tensor. The apparent
"plateau" was identical input, not a model-internal cap, and the tiling comparison
compared unequal workloads. **Those conclusions are withdrawn.**

## Corrected measurement — `scripts/phase2/bench-recognizer.mjs`

One real text line rendered at a controlled CSS width in a wide (4200px) viewport, so
the crop is fully in-bounds; screenshot; then preprocessing / `session.run` / decode
timed separately, median of 5 (warm-up dropped). `onnxruntime-web` wasm,
`numThreads=1`, RTX 4060 laptop, Node (not the popup):

| CSS width | tensor (W×48) | steps | preprocess | session.run | decode |
|-----------|---------------|-------|-----------|-------------|--------|
| 200 px    | 310×48        | 39    | ~355 ms   | ~138 ms     | ~1 ms  |
| 600 px    | 929×48        | 116   | ~1.0 s    | ~370 ms     | ~3 ms  |
| 1200 px   | 1858×48       | 232   | ~2.0 s    | ~790 ms     | ~6 ms  |
| 2400 px   | 3716×48       | 464   | ~4.2 s    | ~1.6 s      | ~12 ms |
| 3600 px   | 5574×48       | 697   | ~6.5 s    | ~2.4 s      | ~18 ms |

### What this actually shows

- **Preprocessing dominates**, ~2.5–2.6× the inference at every width. It is the pure
  JS pixel loop (`(rgba − 0.5)/0.5` over `3·W·48` floats) plus the `getImageData`
  round-trip, not the model.
- Both preprocess and `session.run` scale **~linearly** in tensor width. No plateau.
- `decode` is negligible (<20 ms even at 5574 px).
- A normal single field line (~200–600 CSS px) is ~0.5–1.4 s **per region in Node**;
  the packaged popup (unthreaded WASM, no SIMD/worker in an MV3 popup) is several×
  slower per call. Cost then scales with region **count** — the checkout page's ~13
  structural lines is the 60s driver, and `MAX_REGIONS = 8` already bounds it.

## Changes made this pass

- **`extension/recognize-bounds.ts`** (new, pure, unit-tested): `planRecognizerInput`
  + `RecognizerInputOverflowError`. Width above `MAX_RECOGNIZER_WIDTH = 4096` is
  **withheld before inference**, never squished to fit. A horizontal squish can yield a
  *confidently wrong* transcription that misses PII classification, which the
  `meanConfidence` check cannot catch — so overflow must fail closed, not fall through.
- **`extension/preview.ts`**: catches `RecognizerInputOverflowError` → `withheld`
  `region-too-wide`; adds a `MAX_PREVIEW_MS = 25000` wall-clock budget and an
  `AbortSignal`. Both are checked **between regions** — they bound how many more
  recognizer calls start, not one already running (synchronous WASM `session.run` is
  not preemptible from this thread). This is stated in code.
- **`extension/popup.ts`**: a `previewAbort` controller, re-armed on every run and
  aborted on new-run / Cancel / disconnect; the preview `.then` is now gated on the
  captured `AbortSignal` *only*. It previously also checked `token !== generation`, but
  normal task completion posts `RESULT` which bumps `generation` — so every preview
  that outlived the (fast) fill flow was silently dropped and the UI stuck on
  "Building…". That was masked until now because the checkout page always short-circuits
  to `withheld` before `RESULT` arrives; the real recognition path loses that race.
- **`extension/popup.html` / `popup.css`**: preview-image visibility now toggles a
  `.hidden` class, not `element.style` / an inline `style=` attribute — both are blocked
  by the extension_pages CSP (`style-src 'self'`, no `'unsafe-inline'`), which is why
  the redacted image never actually displayed before.

## Deferred: batched `[N,3,48,W]` inference

`session.run` supports batch > 1 (verified: `[2,3,48,320]` → `[2,40,6625]`). Batching
the ≤8 crops into one call could collapse per-call overhead, but: (a) the dominant
cost is **preprocessing**, not the call, so the upside is smaller than it looked; (b)
padding to a common width needs an accuracy check; (c) it needs packaged **cold/warm
stage** timings from the actual popup, not Node aggregates. Not a prerequisite for the
acceptance fixture. Revisit only if packaged timings justify it.
