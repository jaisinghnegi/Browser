# Phase 2 revised contract: real PII detection + selective redaction

> Status: plan only. No outbound boundary/schema code has been touched. Full withholding
> (Phase 1's behavior) remains the default until every acceptance gate below is met on a
> frozen holdout. This revises the Phase 2 proposal per
> `artifacts/phase2-plan-review/index.md` (Astra), addressing all six findings.

## 0. What stays true from Phase 1

Everything already committed under `extension/`, `server/`, `shared/protocol.schema.json`
keeps working unchanged. This document only describes what is *added*, and gates it behind
evidence before it's allowed to ship.

## 1. Leakage oracle: ground truth, not predictions (finding 1)

The Phase 2 proposal's mistake: checking only *matched* strings and *flagged* boxes for leaks
measures the sanitizer against itself. The revised oracle:

- Every fixture sample ships with **ground-truth secrets and ground-truth boxes**, authored
  independently of any detector/OCR/classifier output.
- Two different checks, because text and image leakage can't be measured the same way:
  - **Text channel**: literal substring search — every ground-truth secret string must not
    appear (whole or fragmented across a join) in the outbound sanitized-text field or in any
    server log.
  - **Image channel**: not a byte/string search over compressed PNG data (meaningless — the
    ground-truth secret is a rendered string, not a byte sequence inside the file format).
    Instead, a **visual coverage/exposure check**: decode the uploaded image and confirm every
    ground-truth box is fully inside an opaque redacted region in the actual pixels that were
    uploaded. A ground-truth region that is even partially unredacted counts as exposed,
    regardless of whether the file's compressed bytes happen to contain a recognizable string.
- Both checks run regardless of whether the pipeline flagged the region — a detector miss, an
  OCR misread that still round-trips a substring of a real secret, a split/multiline address,
  or a fragmented email/phone across regions — all must be caught, not assumed away by "the
  classifier didn't flag it so it must be safe."
- Reported separately, not conflated into one "accuracy" number:
  - detector recall (region proposed vs. ground-truth region),
  - OCR accuracy (recognized text vs. ground-truth text, character/word error rate),
  - classifier recall/precision (category assigned vs. ground-truth category),
  - end-to-end leakage rate (ground-truth secrets exposed via either the text-channel search
    or the image-channel coverage check above — the only number that matters for the privacy
    claim),
  - task utility (did the intended fill still happen correctly).

## 2. Failure/uncertainty policy: zero upload stays zero upload (finding 2)

Phase 1's contract is **zero upload on failure**. Phase 2 does not get to redefine that down
to "zero upload of the affected region." Revised policy:

- Model load failure, inference failure, or timeout on **any** stage (detector or recognizer)
  → the whole task fails closed, exactly like Phase 1's vision failure today. No partial
  payload is built.
- A stage that *runs successfully* but is uncertain about one specific region (e.g. detector
  fires, recognizer confidence is below threshold on that region) → that individual region is
  conservatively masked, and this is the only case where "mask the region" is the policy —
  it requires the pipeline to have actually produced a confident-enough signal to know a
  region exists there. Absence of a signal is not evidence of absence of sensitive content.
- Any visual content the pipeline doesn't have coverage for at all (a category outside the
  bounded list in §5, an unsupported script, non-text sensitive content, a canvas/iframe
  region it can't see into) → the whole task **falls back to full withholding** (Phase 1's
  existing behavior) rather than silently treating unflagged pixels as safe to upload as-is.
- Net effect: three outcomes per task, never four — (a) full withhold, (b) selectively
  redacted upload with proven regions covered, (c) zero upload on failure. There is no
  "upload of pixels the pipeline never actually looked at."

## 3. Technical specification (finding 3)

Phase 1's PP-OCRv4 component only emits a probability map + a raw text-pixel count — it has
no notion of boxes, and there is no recognition step at all. Concrete spec required before any
implementation:

- **Map → regions**: threshold the probability map (reuse the existing 0.3 threshold as a
  starting point, revisit empirically), connected-component labeling to group adjacent
  above-threshold pixels into candidate regions, then a minimum-area-rectangle (not just
  axis-aligned bounding box, since address text can be at a slight angle from page zoom/DPR)
  per component, expanded outward by a fixed margin (detector masks characteristically shrink
  slightly inside true glyph boundaries — the margin compensates so redaction boxes don't clip
  edge pixels of the real text). Adjacent components on the same text line (and adjacent lines
  belonging to the same block, e.g. a multiline address or a name directly above/below it) are
  grouped into one region *before* the minimum-area filter runs, not after — grouping first
  means a run of individually-tiny components (which might each look like noise) is correctly
  sized once merged.
  **Any component or group below the minimum-area threshold is masked or the sample falls back
  to full withholding — never silently dropped as noise.** A region small enough to be
  discarded as noise is also small enough to plausibly be a fragment of real text; the minimum
  is a masking-vs-full-withhold decision, not a discard decision.
- **Coordinate transforms**: `vision.ts` resizes to `width = round(naturalWidth * scale / 32) *
  32` and `height = round(naturalHeight * scale / 32) * 32`, rounded **independently per
  axis** with no padding — so the actual per-axis scale factors used for inverse-mapping a
  detector-space coordinate back to screenshot pixel space are `naturalWidth / width` and
  `naturalHeight / height` (measured from the real output dimensions), not the nominal `scale`
  variable, which the independent rounding makes slightly wrong per axis. `captureVisibleTab`'s
  screenshot pixels are already physical (DPR-scaled) pixels — this transform stays entirely in
  that physical-pixel space for cropping/masking the uploaded image; `devicePixelRatio` is only
  divided out separately, once, when converting to CSS coordinates for anything that needs to
  align with DOM geometry (it must not be multiplied a second time into the detector-resize
  scale factors above). Test cases: a non-square screenshot, a size that rounds up on one axis
  and down on the other, and a fractional `devicePixelRatio` (e.g. 1.5), asserting the
  round-tripped box lands within one pixel of the known ground-truth box in each case.
- **Crop order**: detect on the full (resized) frame first, transform boxes back to
  full-resolution pixel space using the per-axis factors above, crop each region from the
  **original, undownsampled** screenshot for recognition — not from the downsampled detector
  input — so small text isn't handed to the recognizer pre-blurred.
- **Recognition model (pinned, verified by actually downloading and hashing both files)**:
  - Model: `ch_PP-OCRv4_rec_infer.onnx` from the same repo/revision as the existing detector —
    https://huggingface.co/SWHL/RapidOCR/resolve/5e7ff7a3692252dd21f42d8c7fd07b9905a1b114/PP-OCRv4/ch_PP-OCRv4_rec_infer.onnx
    (10,857,958 bytes, SHA256
    `48fc40f24f6d2a207a2b1091d3437eb3cc3eb6b676dc3ef9c37384005483683b`), Apache-2.0, same
    upstream (PaddleOCR) as the detector already documented in `models/README.md`. The "ch"
    (Chinese+English) recognizer is used rather than a Latin-only one because no v4 Latin-only
    recognizer artifact exists in this repo; its dictionary is a superset that still covers the
    ASCII/digits/punctuation needed for §5's bounded categories.
  - Dictionary: PaddleOCR's `ppocr_keys_v1.txt` —
    https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/release/2.7/ppocr/utils/ppocr_keys_v1.txt
    (26,249 bytes, SHA256
    `28b2362ad4ab2dc38769aa72feb535e3a9ddb3fd2a7585a05920e6393b1dc7f7`, 6,623 lines), Apache-2.0.
  - Decode: CTC greedy decode, per PaddleOCR's standard recognition head for this model family
    (to be double-checked against the model's actual output shape once integrated, not assumed
    blind) — output is expected to be `[1, T, 6625]` (6,623 dictionary entries + CTC blank +
    the trailing space class PaddleOCR appends), argmax per timestep, then CTC blank/repeat
    collapse.
  - Preprocessing: PaddleOCR recognition preprocessing differs from the detector's — fixed
    height (32px) with variable width scaled to preserve aspect ratio, BGR, normalized to
    `[-1, 1]` via `(pixel/255 - 0.5) / 0.5` per PaddleOCR's rec pipeline (distinct from the
    detector's ImageNet mean/std) — to be verified against the model's actual expected input
    once loaded, not assumed from documentation alone.
  - Both files will be added to `scripts/download-model.mjs` following the exact pattern
    already used for the detector (pinned hash checked before and after download, packaged
    into `dist/`, never fetched at runtime).
- **Masking**: redaction boxes must be **opaque, full alpha**, drawn directly into the
  re-encoded PNG that gets uploaded (not a CSS overlay, not a separate "preview" layer) —
  Phase 1's existing distinction between "the full-withholding panel is policy, not a redacted
  screenshot" goes away once Phase 2 actually uploads image bytes; those bytes must be the
  real, re-encoded, redacted image with no separate original ever transmitted or logged.
  Strip any embedded metadata on re-encode.
- **Mask verification in tests**: pixel-diff against the ground-truth box is not sufficient
  on its own ("some pixels changed" doesn't prove full coverage or opacity). Tests must
  assert: (a) full ground-truth-box coverage — every ground-truth pixel is inside a redacted
  box, accounting for DPR/resize transforms and edge-clipping at frame boundaries, (b) the
  redacted region's alpha is fully opaque with the fixed mask color, no antialiased edge
  leaking original pixels, (c) multiline ground-truth text is covered by a union of boxes, not
  just the first line.

## 4. This is a versioned outbound-boundary change (finding 4)

Adding text/image fields to what crosses the planner boundary is **not** an internal detail —
it changes the trust contract Phase 1 spent its whole design on. Treated accordingly:

- `shared/protocol.schema.json` gets a new schema **version** (protocol `2`, not a silent
  field addition to protocol `1`). Server and extension both branch on `protocol` and reject
  anything they don't recognize — no implicit upgrade.
- Today, `scripts/generate-contract.mjs` generates `extension/generated/validators.js` (Ajv
  validator functions, gitignored) and `validators.d.ts` (checked in) from
  `shared/protocol.schema.json`; `server/models.py`'s Pydantic models are **manually kept in
  sync** with that same schema, not generated, and a test asserts the two agree. Adding
  protocol 2 doesn't change this mechanism, but does mean maintaining two message shapes (1
  and 2) side by side through the transition — the schema-agreement test needs to cover both,
  and the manual Pydantic mirroring for protocol 2 needs the same scrutiny finding 4 asks for
  everywhere else (no shortcut just because it's not auto-generated).
- New fields (`sanitizedText`, `redactedImage` or similar) are **only ever settable by the
  sanitizer's output**, never by spreading a raw observation into the payload — same
  `buildPayload`-owns-construction discipline as Phase 1, extended to cover the new fields.
  Raw screenshot bytes and raw recognized text must not be reachable from the same code path
  that builds the outbound payload; keep them in a separate, non-exported intermediate type.
- Sanitized output is **bound to the observation it was computed from** (task/observation/
  document/version, same binding shape as Phase 1) and revalidated immediately before upload
  — a sanitized result computed against a since-mutated page must be rejected the same way a
  stale Phase 1 action is rejected today.
- Explicit size limits on the new fields (max image dimensions/bytes, max text length),
  enforced the same way `readCapped`'s cap is enforced — checked before/while reading, not
  after buffering.
- New tests required: rejection of a raw/extra field sneaking into the protocol-2 payload,
  oversized image/text rejected, stale sanitized result (page mutated after sanitization, 
  before upload) rejected, and a schema-version mismatch (protocol 1 talking to a
  protocol-2-only server or vice versa) rejected cleanly rather than silently coerced.

## 5. Bounded scope: categories, language, and what's explicitly out (finding 5)

- **In scope**: US/IN-style postal addresses in Latin script, IN 10-digit phone numbers
  (with/without `+91`/`0` prefix), email addresses. Format/template list will be written out
  explicitly in the labeled-set spec (not left implicit in regexes) before implementation.
- **Names**: a name adjacent to or embedded in an address block is address-block content, not
  a separately classified category in this pass — the redaction unit is the whole flagged
  address-shaped region, not a token-level name/number split. This is called out explicitly
  because finding 5 flagged that a name could otherwise survive next to a redacted number.
- **Explicitly out of scope, not silently "safe"**: any script other than Latin, PAN/Aadhaar-
  style ID formats, phone formats for other countries, faces, document images, any text
  rendered inside `<canvas>`/`<iframe>` the content script can't read, and any non-text
  private content (e.g. an embedded map pin). Content in any of these buckets triggers the
  full-withholding fallback from §2, not an assumption of safety.
- **The fallback in §2 is a real gate, not a promise the text detector can enforce on its
  own**: a text-region detector cannot discover a face, a map, an ID photo, or text in a
  script/format it was never trained to recognize — it simply won't fire on those, which is
  not the same as "detected and confirmed absent." So eligibility for selective redaction is
  restricted structurally, before the detector ever runs, to: (a) known synthetic fixture
  layouts built for this evaluation, (b) a supported rendering surface (plain DOM text/inputs
  the content script can enumerate — not canvas/iframe/shadow-DOM content), and (c) pages that
  don't declare or contain any of the out-of-scope content types the fixture author knows
  about. A page's own declaration of "no sensitive content here" is never trusted — the
  restriction is what pages/layouts the *system* is allowed to run selective redaction on at
  all, decided by what fixture set a sample belongs to, not by asking the page. Anything
  outside that known-eligible set uses full withholding unconditionally, independent of what
  the detector does or doesn't find on it. This is a conservative structural exclusion, not a
  claim that the detector "understands" faces/maps/scripts it was never built to handle.
- The privacy claim stays scoped to labeled synthetic fixtures matching this list — same
  discipline as Phase 1's README, extended rather than loosened.

## 6. Evaluation discipline (finding 6)

- The labeled sample set is split into **tuning** and **holdout** *before* any threshold is
  chosen, and the split is committed (file list + hashes) before tuning starts. If the first
  holdout ends up used to pick a threshold after all (i.e., it stops being a true holdout), a
  **fresh** holdout is drawn and the old one is explicitly retired in the commit message —
  never quietly reused as if untouched.
- Reported numbers: per-category precision/recall/leakage as in §1, **plus** false-positive
  rate and a benign-content-survival check, reported separately from the leakage numbers —
  a run that redacts everything trivially hits zero leakage and that must not be presented as
  a privacy win.
- An **all-benign control set** (pages/fixtures with zero seeded secrets) is part of the fixed
  suite: it must complete tasks normally with no or minimal redaction, proving the system
  doesn't degrade to "black out the whole page." Over-redaction on this set is reported as a
  utility cost, not counted toward "leaks prevented."
- Sample counts and the tuning/holdout split are stated plainly in whatever report/README
  section documents Phase 2 results — no numbers presented without denominators.

## Delivery sequence (adopting Astra's ordering)

1. ~~Durable `readCapped` regressions~~ — done, commit `fac1b63`.
2. This document + the concrete labeled-sample-set spec and candidate model pins, checked in
   next. **Uploads remain unchanged (Phase 1 full withholding) through this step.**
3. Local-only OCR/detection/masking implementation, proven against all ground truth per §1/§3,
   with the failure-injection and benign-control tests from §2/§6 — still no new field ever
   reaches the outbound payload at this step.
4. The protocol-2 outbound schema/transport change (§4), submitted separately with its own
   commit and evidence, only after step 3's gates are met on the frozen holdout.

I will coordinate with Astra before running the Playwright suite for step 3/4's browser tests,
since build output and port 8171 are shared.
