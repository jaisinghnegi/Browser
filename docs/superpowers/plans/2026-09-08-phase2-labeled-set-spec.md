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

## 2. Ground-truth schema

```jsonc
{
  "fixture": "fixture-address-01",          // matches the served path suffix
  "regions": [
    {
      "category": "address" | "phone" | "email",
      "text": "71 Visible Road, Sample City 11111",   // exact rendered ground truth
      "box": { "x": 0, "y": 0, "width": 0, "height": 0 }, // CSS px, top-left origin, at a
                                                            // declared reference viewport size
      "multiline": false,
      "note": "optional free-text, e.g. 'adjacent name in same block'"
    }
  ],
  "referenceViewport": { "width": 1000, "height": 800, "devicePixelRatio": 1 },
  "hardNegative": false   // true for hard-negative samples, see §4
}
```

`box` coordinates are declared at one fixed reference viewport/DPR per sample; the evaluation
harness is responsible for driving the browser at that exact size (Playwright already fixes
`viewport: { width: 1000, height: 800 }` for Phase 1's e2e suite — Phase 2 reuses that as the
default reference and only introduces a second reference size for the DPR/rounding test cases
called out in the plan's §3).

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

## 4. Hard negatives (must NOT be flagged)

Explicit non-PII strings that are shaped like the categories above, to catch over-eager
regexes:

- A 10-digit number that is an order/tracking ID, not a phone number (in a labeled non-phone
  context, e.g. "Order #9876543210").
- A street-address-shaped string used as a business name or landmark description with no
  actual deliverable address attached.
- An `@`-containing string that is a social handle (`@sample_user`), not an email.
- A postal-code-shaped number in an unrelated numeric context (e.g. a price or quantity).

## 5. All-benign control set

Separate pages with **zero** seeded sensitive regions and normal, useful page content (e.g. an
order-confirmation page with a non-PII order number, a product description, terms text). Used
for §6's benign-content-survival check — proves the system doesn't degrade to over-redaction on
ordinary text.

## 6. Sample counts and split

Starting scale (small, deliberately — grown later if the categories above prove insufficient
to expose failure modes):

| Set | Count | Purpose |
|---|---|---|
| Tuning | 18 | 6 per category (address/phone/email), used to pick detection/recognition thresholds |
| Holdout | 12 | 4 per category, **frozen before any tuning**, used only for final reported numbers |
| Hard negatives | 8 | 2 per §4 bullet, split 4 tuning / 4 holdout |
| Benign control | 6 | 3 tuning / 3 holdout |
| **Total** | **44** | |

The tuning/holdout split is committed as a plain file list (`fixtures/phase2/tuning.json`,
`fixtures/phase2/holdout.json`, each an array of fixture basenames) in the same commit that
introduces the first fixture files — before any threshold is chosen against them, so the split
commit itself is the evidence the freeze happened before tuning, not an after-the-fact claim.

## 7. What this spec does not cover yet

- The actual fixture HTML files and ground-truth JSON (next artifact, generated from this
  spec).
- Detection/recognition/redaction implementation (blocked on the fixtures existing).
- Any change to `extension/**` or `server/**` runtime code.

## 8. Coordination note

Generating the fixture HTML/JSON files is a pure content addition (new files under
`fixtures/phase2/`, no shared-file edits) and doesn't touch anything Astra would be
independently reviewing at the same time — no build/port coordination needed for this step.
I'll flag before the first step that touches `extension/**`/`server/**` or runs the Playwright
suite, per your port/build note.
