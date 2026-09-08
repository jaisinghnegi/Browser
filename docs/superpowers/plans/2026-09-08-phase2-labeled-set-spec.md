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
- Zero or one **target input field** (matching Phase 1's `#shipping-address` pattern) whose
  correct fill value comes from the local vault, never from a seeded region.
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
  "tags": ["mixed" /* | "split" | "nonSquareDPR" */],
  "referenceViewport": { "width": 1000, "height": 800, "devicePixelRatio": 1 },
  "fontPx": 16,
  "task": false,  // true only for benign-control samples, which carry a fill task for utility measurement
  "regions": [
    {
      "category": "address" | "phone" | "email" | "name-in-address" | "ambiguous" | "benign",
      "text": "107 Cedar Court\nSample City, ST 11112",  // exact ground-truth secret text
      "multiline": true,
      "note": "optional free-text",
      "box": { "x": 24, "y": 24, "width": 155.6, "height": 42 },       // union bounding box
      "lineBoxes": [ { "x": 24, "y": 24, "width": 115.4, "height": 21 },  // per-visual-line
                      { "x": 24, "y": 45, "width": 155.6, "height": 21 } ] // real glyph bounds
    }
  ]
}
```

`box`/`lineBoxes` are **measured, not authored** — see §6. `box` is the overall bounding
rectangle (a union of all lines, useful for single-line regions); `lineBoxes` gives one
glyph-tight rectangle per rendered visual line, which is what the future mask-coverage check
(Phase 2 plan §3) should actually verify against for multiline text, rather than one loose
box that would overstate what a real redaction needs to cover.

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
`scripts/generate-phase2-fixtures.mjs` (manifest → static HTML under `fixtures/phase2/pages/`)
and `scripts/measure-phase2-fixtures.mjs` (loads each page in a real headless Chromium via
Playwright at its declared reference viewport/DPR, and measures **actual rendered CSS
`getClientRects()`** on each labeled region — real glyph-tight bounds, not the containing
block's full width, and independent of any detection model, per §3's requirement). The
measurement script also cross-checks rendered text against the manifest and asserts every
region has a positive-area box and the expected line count before writing ground truth, so a
template/escaping bug can't silently produce wrong ground truth.

`scripts/freeze-phase2-split.mjs` writes `fixtures/phase2/tuning.json` and `holdout.json`: the
frozen fixture-id list per set plus a SHA256 of each fixture's HTML and ground-truth JSON. A
committed test (`tests/phase2-fixtures.test.ts`) asserts these hashes still match the files on
disk, the 25/19/44 counts, no duplicate secrets, every manifest id has a split entry and vice
versa, every ground-truth box has positive area with the expected line count, and that
ambiguous-shaped/benign-control samples carry the labels §4/§5 require. This is the durable
evidence that the freeze happened before tuning, not an after-the-fact claim in prose.

### Manifest coverage of the required special cases

Rather than separate fixtures for every special case (which would multiply the count without
adding new failure modes), a handful of the 44 samples are tagged to also cover:

- **Mixed-category page**: one email-primary sample additionally carries an address and a
  phone region on the same page (`tags: ["mixed"]`).
- **Split fields**: two phone samples and two email samples render their secret across two
  separate DOM elements/lines (`tags: ["split"]`) — one fragment per element.
- **Tiny characters**: two samples (one address, one email) render their secret region at
  10px instead of the default 16px (`fontPx: 10`).
- **Non-square / fractional DPR**: one address sample uses a `900×1200` viewport at
  `devicePixelRatio: 1.5` instead of the `1000×800`/`1` default.

## 7. Canonicalization and fragment matching for the future leakage oracle

Specified now so the oracle (built in delivery-sequence step 3, alongside detection) has a
fixed contract to implement against, not an ad-hoc one invented later:

- **Whitespace canonicalization**: before any substring search, both the ground-truth secret
  and the candidate outbound text are canonicalized identically — collapse all whitespace runs
  (including newlines) to a single space, then trim. This prevents a multiline address (stored
  with an internal `\n` in ground truth) from evading a search that only checks for the literal
  `\n`-joined string, and prevents cosmetic reformatting from masking a real leak.
- **Fragment matching**: a full ground-truth secret string match is not the only failure mode —
  a long enough contiguous substring of a secret (e.g. a phone number missing its last two
  digits, or half of a split address rendered without the other half redacted) is still
  exposure. The oracle checks substrings of at least a fixed minimum length (to be tuned once
  real detector/OCR failure modes are observed; starting point: 6 characters, since that's
  below the shortest in-scope secret fragment worth flagging but long enough to avoid matching
  incidental short common substrings) against the canonicalized outbound text, not only the
  full string.
- **Split-region secrets** (§6's `split` tag): the oracle checks each fragment independently
  *and* the concatenation of adjacent fragments, since either an individually-exposed fragment
  or a reconstructable concatenation counts as a leak.
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
