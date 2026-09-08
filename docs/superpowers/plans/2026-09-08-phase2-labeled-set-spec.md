# Phase 2 labeled sample-set spec

> Status: spec only. No fixture files or ground-truth data exist yet. This defines the shape
> before generating anything, per the delivery sequence in
> [the Phase 2 plan](2026-09-08-phase2-detection-redaction.md#delivery-sequence-adopting-astras-ordering).
> Still no upload changes.

## 1. Fixture layout family

All samples are variations on the existing Phase 1 fixture pattern: a single local HTML page
served from `http://localhost:8171/fixture-*`, added to the runtime eligibility allowlist
described in the Phase 2 plan §5. Each sample is one page with:

- Zero or more **seeded sensitive regions**: visibly-rendered text blocks matching one of the
  in-scope categories below, placed at a known location.
- **A target input field** (matching Phase 1's `#shipping-address` pattern) whose correct fill
  value comes from the local vault, never from a seeded region. **Correction**: an earlier
  draft gave this only to the benign-control set, so utility/correct-fill was measurable only
  on pages with nothing to leak, and input presence itself became a confound between the
  "sensitive" and "benign" halves of the corpus. Every fixture now carries the identical fill
  affordance, so privacy (no leak) and utility (correct fill) are measured together on the
  same sensitive/mixed/ambiguous pages, not on two structurally different page populations.
- **Two HTML variants, identically rendered**: `fixtures/phase2/pages/<id>.html` (the real
  fixture — no `data-gt-*`/`data-fixture-id` attributes at all, so nothing reading this page
  can use them as an answer key) and `fixtures/phase2/pages-labeled/<id>.html` (adds those
  attributes, read *only* by the offline measurement tooling in §6, gitignored — never loaded
  by anything else). No CSS in either tree selects on these attributes, so they don't affect
  layout; ground truth measured from the labeled tree is valid for the clean tree.
- A **ground-truth JSON file**, same basename as the fixture, never read by any runtime code —
  only by the offline evaluation harness (test code, not `extension/**`).

## 2. Ground-truth schema (as actually generated — see §6)

```jsonc
{
  "fixture": "address-tuning-01",
  "set": "tuning", // or "holdout"
  "primaryCategory": "address",
  "hardNegative": false,   // true only for the ambiguous-shaped set, see §4
  "benign": false,         // true only for the benign control set, see §5
  "tags": ["mixed" /* | "split" | "tiny" | "nonSquareDPR" | "altLayout" */],
  "referenceViewport": { "width": 1000, "height": 800, "devicePixelRatio": 1 },
  "fontPx": 16,
  "task": true,  // every fixture carries the fill affordance now, see §6's correction
  "renderer": { "engine": "chromium", "version": "153.0.8010.12" }, // measured at generation time
  "computedFontFamily": "system-ui, sans-serif", // or the altLayout serif stack, as actually rendered
  "regions": [
    {
      "category": "address" | "phone" | "email" | "name-in-address" | "ambiguous" | "benign",
      "text": "107 Cedar Court\nSample City, ST 11112",  // exact ground-truth secret text
      "multiline": true,
      "note": "optional free-text",
      "groupId": "phone-tuning-05-g0",  // only on split-fragment regions, see §7
      "fullText": "9538271605",          // only on split-fragment regions: the reassembled entity
      "box": { "x": 24, "y": 24, "width": 155.6, "height": 42 },       // union layout-box bounds
      "lineBoxes": [ { "x": 24, "y": 24, "width": 115.4, "height": 21 },  // per-visual-line
                      { "x": 24, "y": 45, "width": 155.6, "height": 21 } ] // layout-box bounds
    }
  ]
}
```

`box`/`lineBoxes` are **measured, not authored** — see §6. `box` is the overall bounding
rectangle (a union of all lines, useful for single-line regions); `lineBoxes` gives one
rectangle per rendered visual line. **Correction**: an earlier draft called these boxes
"glyph-tight"/"real glyph bounds." That overstates what `getClientRects()` actually returns —
a CSS inline **layout box** (line-box) derived from font metrics (ascent/descent/line-height),
not a per-character glyph-ink bounding box; real ink can sit slightly inside this box depending
on the font. This is still the right ground truth for "does a redaction box drawn here cover
the rendered line" (Phase 2 plan §3's mask-coverage check), just not a claim about exact glyph
pixels. `renderer`/`computedFontFamily` are recorded per fixture so a re-measurement on a
different browser/font environment can be diffed against this one instead of assumed identical.

## 3. In-scope category templates (explicit, not left implicit in regex)

**Address** (US/IN-style, Latin script):
- `{number} {street}, {city} {postal}` — e.g. `991 Vault Lane, Testville 00000` (Phase 1's
  existing seed) or `71 Visible Road, Sample City 11111` (Phase 1's existing seeded region).
- Multiline variant: street line, then `{city}, {state} {postal}` on a second line.
- IN-style variant: `{house/flat}, {street/area}, {city} - {6-digit PIN}`.
- With an adjacent name directly above the address block (tests §5's "name is part of the
  address-block redaction unit" rule).

**Phone** (India, 10-digit):
- Bare: `9876543210`
- With country code: `+91 9876543210`, `+919876543210`
- With leading zero (STD-style local dialing convention some UIs still render): `09876543210`
- With separators: `98765-43210`, `98765 43210`

**Email**:
- `local@domain.tld` — ASCII local part (letters/digits/`.`/`_`/`-`), common TLDs. No
  internationalized/unicode local parts or domains in this pass (out of scope, same as other
  non-Latin content).

## 4. Ambiguous-shaped content (evaluated, never a "must not flag" requirement)

**Correction**: an earlier draft of this spec called these "hard negatives" and required they
"must NOT be flagged." That's backwards for a privacy tool — an ambiguous 10-digit number next
to "Order #" is still a value that *could* be a phone number; the system doesn't get to assume
it isn't just because that would produce a cleaner false-positive number. Blanket context
exemptions built to hit zero false positives on this set would be a regression, not a feature.

Revised treatment: this is a set of strings shaped like an in-scope category but with
different, offline-labeled intended semantics:

- A 10-digit number in an order/tracking-ID context, not a phone number.
- A street-address-shaped business name or landmark description with no deliverable address.
- An `@`-containing social handle, not an email.
- A postal-code-shaped number in an unrelated numeric context (price, quantity).

What the labels are used for:
- **Not** a runtime input, and **not** a required-unflagged set. The system may conservatively
  mask any of these, and doing so is reported as a **utility cost** (unnecessary redaction),
  never counted as a leak or as a failure.
- The offline label records *intended* semantics purely for reporting granularity (e.g. "the
  system masked 6/8 ambiguous samples" is a utility-cost number, distinct from "the system
  missed a real secret").
- **Never** used as the benign-survival control in §5/§6 — that check needs content that is
  unambiguously not shaped like any in-scope category, precisely so a conservative-masking
  policy can't be penalized by it. This set exists to characterize over-redaction cost, not to
  prove pages "survive" redaction.

## 5. All-benign control set

Separate pages with **zero** seeded sensitive regions and normal, useful page content (e.g. an
order-confirmation page with a non-PII order number, a product description, terms text). Used
for §6's benign-content-survival check — proves the system doesn't degrade to over-redaction on
ordinary text.

## 6. Sample counts and split (corrected)

**Correction**: an earlier draft's table only counted the three main categories per row (18
tuning / 12 holdout) and left the ambiguous-set and benign-control rows out of the row totals,
even though they belong to "tuning" and "holdout" respectively. Corrected:

| Set | Address/phone/email | Ambiguous-shaped | Benign control | **Row total** |
|---|---|---|---|---|
| Tuning | 18 (6 per category) | 4 | 3 | **25** |
| Holdout | 12 (4 per category) | 4 | 3 | **19** |
| **Grand total** | | | | **44** |

Generated (not hand-authored) via `scripts/build-phase2-manifest.mjs` (deterministic content:
distinct synthetic names/streets/numbers/domains per sample, no randomness, no duplicate
secret string anywhere in the set — enforced by a build-time check), then
`scripts/generate-phase2-fixtures.mjs` (manifest → static HTML, written to both
`fixtures/phase2/pages/` — the real fixture, no `data-gt-*` — and
`fixtures/phase2/pages-labeled/` — same rendering plus those attributes, measurement-tooling-
only, gitignored) and `scripts/measure-phase2-fixtures.mjs` (loads each **labeled** page in a
real headless Chromium via Playwright at its declared reference viewport/DPR, and measures
**actual rendered CSS `getClientRects()`** on each region — real CSS inline layout-box bounds
per visual line, not the containing block's full width, and independent of any detection
model, per §3's requirement; see §2's correction on what "layout box" does and doesn't mean).
The measurement script also cross-checks rendered text against the manifest and asserts every
region has a positive-area box and the expected line count. **Correction**: an earlier version
of this script wrote ground-truth files as it went and only reported failures at the end,
meaning a bad run could leave partially-invalid ground truth on disk even though the process
exited nonzero. It now buffers every fixture's measurement in memory first and writes nothing
to disk unless the entire run has zero failures — an invalid measurement can never partially
overwrite good frozen ground truth.

`scripts/freeze-phase2-split.mjs` writes `fixtures/phase2/tuning.json` and `holdout.json`: the
frozen fixture-id list per set plus a SHA256 of each fixture's **clean** (`pages/`, not
`pages-labeled/`) HTML and its ground-truth JSON. A committed test
(`tests/phase2-fixtures.test.ts`) asserts these hashes still match the files on disk, the
25/19/44 counts, no duplicate secrets, every manifest id has a split entry and vice versa,
every ground-truth box has positive area with the expected line count, every fixture carries
the fill affordance (§1's correction), split-fragment regions share one `groupId`/`fullText`
(§7), clean pages carry no `data-gt-*`/`data-fixture-id` attributes (§1), ground truth records
`renderer`/`computedFontFamily` (§2), and that ambiguous-shaped/benign-control samples carry
the labels §4/§5 require. This is the durable evidence that the freeze happened before tuning,
not an after-the-fact claim in prose.

### Manifest coverage of the required special cases

Rather than separate fixtures for every special case (which would multiply the count without
adding new failure modes), a handful of the 44 samples are tagged to also cover — **and each
tag is enforced (by both the manifest builder and the test) to appear in at least one tuning
and one holdout sample**, correcting an earlier version where `mixed`/`tiny` only appeared in
tuning, so no claim about them could actually be checked against held-out data:

- **Mixed-category page**: one email-primary tuning sample and one email-primary holdout
  sample additionally carry an address and a phone region on the same page (`tags: ["mixed"]`).
- **Split fields**: two phone samples and two email samples (one tuning, one holdout, per
  category) render their secret across two separate DOM elements/lines (`tags: ["split"]`) —
  one fragment per element, with a shared `groupId`/`fullText` recorded, see §7.
- **Tiny characters**: one tuning and one holdout sample (address and email respectively)
  render their secret region at 10px instead of the default 16px (`fontPx: 10`).
- **Non-square / fractional DPR**: one address sample uses a `900×1200` viewport at
  `devicePixelRatio: 1.5` instead of the `1000×800`/`1` default.
- **Layout/font variation**: one tuning and one holdout sample (`tags: ["altLayout"]`) use a
  serif font stack and a centered, bordered, narrower block instead of the default left-aligned
  full-width stack — a modest but real structural difference, added because an earlier draft
  had all 44 samples on one identical layout/font, which would have made any robustness claim
  about layout/font generalization untestable even in principle. This remains a small,
  deliberately narrow variation, not a claim of broad layout/font robustness — that's future
  work (Phase 2 plan §3's "unseen layouts" territory belongs to the later benchmark harness
  phase, not this fixture set).

## 7. Canonicalization and fragment matching for the future leakage oracle

Specified now so the oracle (built in delivery-sequence step 3, alongside detection) has a
fixed contract to implement against, not an ad-hoc one invented later:

- **Whitespace canonicalization**: before any substring search, both the ground-truth secret
  and the candidate outbound text are canonicalized identically — collapse all whitespace runs
  (including newlines) to a single space, then trim. This prevents a multiline address (stored
  with an internal `\n` in ground truth) from evading a search that only checks for the literal
  `\n`-joined string, and prevents cosmetic reformatting from masking a real leak.
- **Every explicit ground-truth secret/fragment is matched in full, regardless of length —
  corrected**. An earlier draft proposed a 6-character minimum before checking a substring at
  all, which would have missed this set's own 5-character split phone fragments (e.g.
  `phone-tuning-05`'s `"95382"`/`"71605"`) entirely — a real, already-present exposure the
  oracle would have silently passed. The rule is now: **every `region.text` (and, for split
  fragments, every fragment individually) is always checked in full**, no minimum length. A
  separate, *additional* sliding-window check applies only beyond the explicit ground-truth
  strings — scanning for any 6+ character contiguous substring of `fullText` (for split
  entities) or of a longer secret that isn't itself one of the recorded fragments, to catch
  exposure the fixed regions didn't anticipate. The minimum-length heuristic bounds that
  *extra* search; it never gates whether a known ground-truth string gets checked.
- **Split-region secrets** (§6's `split` tag): ground truth now records an explicit `groupId`
  (shared by every fragment of one entity) and `fullText` (the reassembled value) on each
  fragment region, so the oracle doesn't have to guess which fragments belong together or
  reconstruct adjacency itself. The oracle checks: each fragment's `text` individually, the
  literal `fullText`, and (via the sliding window above) partial reconstructions in between.
- **Names in address blocks**: per the Phase 2 plan's §5 ("a name adjacent to or embedded in an
  address block is address-block content, not a separately classified category"), the
  `name-in-address` ground-truth regions in this set are included in the secret oracle exactly
  like `address` regions — a redaction that covers the address text but leaves an adjacent name
  block exposed is a leak, not a partial success.

## 8. What this spec does not cover yet

- Detection/recognition/redaction implementation (blocked on the fixtures existing, which are
  now generated — see §6).
- The leakage-oracle *code* itself (the contract is specified in §7; implementation is
  delivery-sequence step 3, alongside detection).
- Any change to `extension/**` or `server/**` runtime code — the fixture-eligibility allowlist
  mechanism described in the Phase 2 plan's §5 is not yet implemented, and per that plan's
  finding-1-style caveat: a page being served from an allowed fixture path is a **restriction
  on eligibility**, not proof that content at that path stayed safe. Once implementation
  starts, the runtime needs its own structural check that rejects content it doesn't recognize
  (e.g. an injected canvas/iframe/unsupported element) even on an allowed path, rather than
  trusting "this URL is on the allowlist" as a stand-in for "this page's content was verified."
  That check is implementation work, not fixture-generation work, and is called out here so it
  isn't lost between this doc and the code that eventually needs it.

## 9. Coordination note

Fixture/tooling generation (this commit) is a pure content addition (`fixtures/phase2/**`,
`scripts/build-phase2-manifest.mjs`, `scripts/generate-phase2-fixtures.mjs`,
`scripts/measure-phase2-fixtures.mjs`, `scripts/freeze-phase2-split.mjs`,
`tests/phase2-fixtures.test.ts`) and doesn't touch anything Astra would be independently
reviewing at the same time — no build/port coordination needed for this step (a Vitest-only
run, not the Playwright *extension* suite; `measure-phase2-fixtures.mjs` does its own
throwaway Playwright browser launch against local files, not the shared port-8171 dev server).
I'll flag before the first step that touches `extension/**`/`server/**` or runs the extension's
Playwright suite, per your port/build note.
