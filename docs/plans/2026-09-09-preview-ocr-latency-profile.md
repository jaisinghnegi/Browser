# Local preview OCR latency — profiling notes (2026-09-09)

Context: the in-popup sanitized-preview recognizer (`extension/recognize.ts` +
`extension/preview.ts`) was measured last session at 60s+ for the Phase 1 checkout
fixture, landing that fixture in a `withheld` state at `MAX_REGIONS = 8`. This is the
"profile before optimizing" pass.

## Corrections to earlier attempts

1. **First benchmark** measured synthetic oversized boxes over a 1000×800 screenshot.
   `image-ops.mjs` clips the source crop to `naturalWidth - x`, so a 1400px and a
   2400px request became the **same** ~2138-wide tensor — the "plateau" was identical
   input, not a model cap. Withdrawn.
2. **Second benchmark** timed "preprocess" as the whole Playwright `evaluate` call,
   which includes serializing `Array.from(input)` (a `3·W·48` array) back to Node. That
   transport does not exist in the popup. Its conclusion ("preprocessing dominates")
   was a harness artifact. Withdrawn.

## Corrected measurement — `scripts/phase2/bench-recognizer.mjs`

One real text line rendered at a controlled CSS width in a 4200px viewport (crop fully
in-bounds); screenshot; preprocess timed **inside the page** (just the canvas draw +
normalize loop), `session.run` and decode timed in Node; median of 5, warm-up dropped.
`onnxruntime-web` wasm, `numThreads=1`, RTX 4060 laptop, Node:

| CSS width | tensor (W×48) | steps | preprocess (in-page) | session.run | decode |
|-----------|---------------|-------|----------------------|-------------|--------|
| 200 px    | 310×48        | 39    | ~0 ms                | ~97 ms      | ~1 ms  |
| 600 px    | 929×48        | 116   | ~1 ms                | ~210 ms     | ~2 ms  |
| 1200 px   | 1858×48       | 232   | ~1 ms                | ~456 ms     | ~4 ms  |
| 2400 px   | 3716×48       | 464   | ~4 ms                | ~1024 ms    | ~8 ms  |
| 3600 px   | 5574×48       | 697   | ~5 ms                | ~1500 ms    | ~13 ms |

(The harness-inclusive "preprocess" number — evaluate round-trip + `Array.from`
transport — was ~226 ms → ~3.4 s over the same range; that is the artifact from
correction 2, printed alongside for reference only.)

### What this actually shows

- **`session.run` is essentially the whole cost.** Preprocess (in-page) and decode are
  both negligible (single-digit ms even at 5574 px).
- `session.run` scales **~linearly** in tensor width (and therefore in CTC timesteps).
- So the two real levers are: (a) **width** — a wide line genuinely costs more, which is
  why oversized regions are now withheld rather than run; (b) **call count** — N regions
  = N `session.run` calls, bounded today by `MAX_REGIONS = 8`.
- These are **Node** numbers. The packaged popup (unthreaded WASM, no SIMD/worker in an
  MV3 popup) is several× slower per call; that multiple is still unmeasured — see below.

## Changes made this pass

- **`extension/recognize-bounds.ts`** (new, pure, unit-tested): `planRecognizerInput`
  + `RecognizerInputOverflowError`. Width above `MAX_RECOGNIZER_WIDTH = 4096` is
  **withheld before inference**, never squished to fit. A horizontal squish can yield a
  *confidently wrong* transcription that misses PII classification, which the
  `meanConfidence` check cannot catch — so overflow must fail closed, not fall through.
- **`extension/preview-gate.ts`** + **`extension/preview-regions.ts`** (new, pure,
  unit-tested) + **`preview.ts`**: the recogniser loop + every fail-closed check is now
  `resolveRegions(lines, recognize, interruptCheck)` — no canvas/model imports, so it is
  unit-testable with injected fakes. `evaluatePreviewInterrupt(aborted, elapsedMs,
  deadlineMs)` is checked before each region **and once more after the final awaited
  recognition**; `tests/preview-regions.test.ts` proves the post-loop recheck by scripting
  an interrupt that only fires on that last call (deleting the recheck fails the test).
  Also catches `RecognizerInputOverflowError` → `withheld` `region-too-wide`. This is
  **cooperative cancellation, not a hard execution cap**: a synchronous WASM `session.run`
  already running is not interrupted — only its result is discarded.
- **Test-only build hook** `PREVIEW_PACE_MS` (esbuild define, 0 in every real build,
  set only by `build:e2e-isolated`): an artificial per-region delay so lifecycle-race
  e2e (Cancel / supersede while a build is genuinely still running, with the button in
  its real enabled state) is deterministic on fast machines.
- **`extension/recognize.ts`**: the recognizer session is now a per-build
  `RecognizerSession` instance (created by `buildLocalPreview`, released in its own
  `finally`), not a module global. Overlapping builds (a supersede landing mid-inference)
  no longer share a session or race each other's cleanup.
- **`extension/popup.ts`**: a `previewAbort` controller, re-armed on every run and
  aborted on new-run / Cancel / disconnect; the preview `.then` is gated on the captured
  `AbortSignal` *only*. It previously also checked `token !== generation`, but normal
  task completion posts `RESULT` which bumps `generation` — so every preview that
  outlived the (fast) fill flow was silently dropped and the UI stuck on "Building…"
  (masked until now because checkout always short-circuits to `withheld` before
  `RESULT`). Cancel now stays enabled while the preview is still building even after the
  task finishes, and cancelling a preview-only build shows `Not sent. Preview cancelled.`
- **`extension/popup.html` / `popup.css`**: preview-image visibility toggles a `.hidden`
  class, not `element.style` / inline `style=` — both blocked by the extension_pages CSP
  (`style-src 'self'`), which is why the redacted image never displayed before.

## Next: packaged popup stage timings

Still missing: the **actual popup** cold session-create and per-`session.run` times
(the Node numbers above under-state it). That measurement is the gate for whether
batched `[N,3,48,W]` inference is worth it — batch > 1 works (`[2,3,48,320]` →
`[2,40,6625]`), and since `session.run` (not preprocess) is the cost, collapsing N
calls into one is now a plausible win, pending: packaged timings + a padding-accuracy
check. Not a prerequisite for the preview acceptance gate.
