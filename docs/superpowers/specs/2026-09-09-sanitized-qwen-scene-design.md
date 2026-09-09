# Sanitized Qwen Scene Context

## Goal

Give local Qwen enough semantic context to understand the browser task while keeping private values, page pixels, OCR text, arbitrary DOM text, and URLs inside the extension.

The model remains a selector within a closed, pre-authorized action set. It does not gain authority to inspect the page, invent targets or values, or execute actions.

## Trust boundary

The extension may send only:

- bounded enums describing the page, goal, fields, and local detections;
- opaque, task-scoped references already covered by the existing freshness and binding rules;
- small integer counts and boolean state;
- the existing single pre-authorized candidate.

The extension must never send:

- screenshots, crops, image data URLs, or derived pixel data;
- OCR strings or arbitrary DOM strings;
- field values, vault values, addresses, names, or other private content;
- page titles, URLs, origins, free-form labels, or surrounding page text;
- model-generated summaries of any forbidden source.

## Protocol shape

Add one required `scene` object to the reference-only plan request:

```json
{
  "pageKind": "checkout",
  "goal": "fill-shipping-address",
  "controls": [
    {
      "target": "field_ref_1",
      "fieldKind": "shipping-address",
      "state": "empty"
    }
  ],
  "privateCapabilities": [
    {
      "valueRef": "value_ref_1",
      "kind": "address",
      "available": true
    }
  ],
  "localVision": {
    "status": "passed",
    "textPresence": "detected",
    "preview": "local-only-best-effort",
    "pixelsShared": false,
    "ocrTextShared": false
  },
  "allowedActions": ["fill"]
}
```

Initial enum set:

| Field | Allowed values |
|---|---|
| `pageKind` | `checkout`, `form`, `unknown` |
| `goal` | `fill-shipping-address` |
| `fieldKind` | `shipping-address` |
| control `state` | `empty`, `filled` |
| capability `kind` | `address` |
| `localVision.status` | `passed` (the only value that reaches a request; a failed gate withholds the task) |
| `localVision.textPresence` | `detected`, `not-detected` |
| `localVision.preview` | `local-only-best-effort` |
| allowed action | `fill` |

The initial implementation supports one control and one private capability. References retain the existing format and must match the authorized binding. Unknown keys and enum values are rejected.

**`localVision` reports only actual gating facts** (correction to an earlier draft): the optional sanitized OCR preview completes *after* the plan request, so the scene must not carry a masked-region count or category list it cannot yet know. It carries: `status` (the detector gate result — always `passed` for a request that is sent at all), `textPresence` from the real detector output (`textPixels >= 8` → `detected`), and the fixed `preview: "local-only-best-effort"` marker. No fabricated counts/categories; no waiting on the preview.

`pixelsShared` and `ocrTextShared` are fixed protocol assertions and must be `false`. Their presence makes the privacy property visible to Qwen and testable at both boundaries; they are not client-controlled feature flags.

## Scene construction

The extension constructs the scene from trusted program state after page observation and before the plan request:

1. Map the allowlisted fixture and observed field role to fixed enums.
2. Reuse the task-scoped `target` and `valueRef`; do not generate additional capabilities.
3. Derive `empty` or `filled` without reading or serializing the field value.
4. Convert local detector classifications to an allowlisted category set and bounded count. Discard OCR strings.
5. Set both sharing assertions to `false` in code.

No generic DOM-to-text or OCR-to-summary function participates in scene construction.

## Backend and Qwen prompt

The server validates the complete scene before calling Qwen. Validation failure returns the existing generic plan rejection and never reaches the model.

The Qwen prompt includes:

- a concise explanation of the scene fields;
- the validated scene serialized from server-owned types;
- the existing single authorized candidate;
- the rule that scene data is descriptive and does not expand the allowed action set.

The existing resolver and binding recheck remain authoritative. Qwen output cannot introduce another target, value reference, or action.

## User-visible explanation

After a validated action, the popup displays a deterministic sentence built from validated enums, for example:

> Qwen selected the saved address for the detected shipping-address field using sanitized page context.

The popup does not display free-form model reasoning. Failure messages remain generic and fail closed.

The “What leaves this device?” disclosure shows the sanitized scene actually sent, alongside the existing payload view, so the user can inspect the exact semantic context without exposing private values.

## Compatibility and failure behavior

This is an intentional reference-only protocol revision. Extension and backend are rebuilt and deployed together. Requests without the required scene, with extra keys, invalid references, oversized arrays or counts, or forbidden sharing assertions are rejected before Qwen.

If local observation cannot produce a valid scene, the task is withheld. There is no deterministic or less-private fallback.

## Verification

- Unit tests cover enum bounds, counts, unknown keys, reference mismatches, fixed false sharing assertions, and scene construction without reading field values.
- Server tests prove invalid scenes never call Qwen and valid scenes reach the prompt exactly once.
- Wire-level tests assert the complete private address, OCR fixture text, `data:image`, page URL, and arbitrary DOM labels are absent.
- The live Qwen end-to-end test proves the sanitized scene reaches Qwen and the resulting action still passes binding, freshness, expiry, and one-use enforcement.
- Popup tests verify the deterministic explanation and the exact outbound scene disclosure.

## User-authorized scope: real sites + connected Qwen

The user has authorized taking this from the synthetic fixture to a first bounded **real-site**
capability, with Qwen wired into the extension flow:

- **Trigger:** user-invoked (toolbar action). `activeTab` only — no `<all_urls>`, no broad host
  permissions. Works on any active `http(s)` page.
- **Target discovery:** the fixed fixture-URL restriction is replaced by **active-tab +
  document binding** plus **conservative semantic discovery** of exactly ONE unambiguous,
  visible, empty, editable shipping-address field. Discovery signals are read locally only and
  never leave the device:
  - `autocomplete` tokens: `street-address`, `address-line1`, or `shipping street-address` /
    `shipping address-line1`;
  - `name`/`id` matching `/(^|[_-])(street[_-]?address|address[_-]?line[_-]?1|addr(ess)?1?)($|[_-])/i`
    combined with a shipping hint (`/ship/i` in `name`/`id`/form id) OR an associated `<label>`
    whose text matches `/address/i` and not `/email|billing|company|phone/i`.
  - Must be `<input type=text|search>` or a single-line `<textarea>`, `offsetParent` non-null,
    inside the viewport, `getComputedStyle` visible, not `disabled`/`readOnly`, value `=== ''`,
    and `document.elementFromPoint(center)` is the field itself.
  - **> 1 candidate, 0 candidates, hidden/readonly/prefilled only → fail closed** (`data-reason`
    `field-not-visible` / `field-not-empty` / `observation-failed`, generic popup text).
- **Value source:** a **local address vault** the user enters once. Stored in
  `chrome.storage.session` (in memory for the browser session, never written to disk, cleared
  on browser close) behind a new `"storage"` permission. Honest lifetime disclosure in the
  popup. The synthetic `991 Vault Lane` seed is used **only** on the bundled fixtures, never on
  a real origin; on a real origin with no vault set, the task is withheld with a "set your
  address first" prompt.
- **Action:** `fill` one field. **No form submission**, no clicks, no navigation, no
  multi-step or autonomous behavior. One-use, expiring, document/element/version-bound exactly
  as today.
- **Outbound:** protocol-2 request = the existing opaque refs + the bounded `scene`. Still
  **no** raw URL, origin, DOM text, `<label>` text, OCR output, pixels, `data:image`, field
  value, or vault value on the extension→backend or backend→Qwen wire.
- **Planner:** real Qwen (`PLANNER_MODE=vlm`) selecting within the single pre-authorized
  candidate, given the scene. `deterministic` mode still supported and honestly labelled.
- **Fixtures stay** for reproducible tests; a **second, non-fixture origin** with realistic
  address markup is added for real-site coverage.

### Ref cross-checks (both sides)

`scene.controls[0].target` must `===` `request.target`; `scene.privateCapabilities[0].valueRef`
must `===` `request.valueRef`; `scene.controls[0].fieldKind` must `===` `request.fieldKind`;
`scene.goal` fixed `fill-shipping-address`. Enforced in `buildPayload` (extension) **and** in
the server scene validator before Qwen. Mismatch → reject before the model, generic rejection.

### Deterministic explanation

Popup shows one fixed sentence, chosen by the *actual* planner mode reported by `/health`:

- vlm: `Qwen selected your saved address for the detected shipping-address field using
  sanitized page context (no page text, URL, or pixels were sent).`
- deterministic: `The demo planner selected your saved address for the detected
  shipping-address field. No page text, URL, or pixels were sent.`

No model prose. The "What leaves this device?" panel shows the exact `scene` JSON next to the
payload.

## Executable plan

**Slice 1 — schema + backend scene contract** (`shared/protocol.schema.json`,
`scripts/generate-contract.mjs` output, `server/models.py`, `server/vlm_planner.py`,
`server/test_*`):
- add `protocol: 2` request variant with required `scene` (draft-07, `additionalProperties:false`
  throughout, bounded arrays len 1, enums per the table, `pixelsShared`/`ocrTextShared` `const false`).
- `PlannerRequest` accepts protocol 1 (unchanged) or 2 (+scene). Pydantic `Scene` model,
  server-owned, `extra='forbid'`, strict.
- `vlm_planner`: validate scene → cross-check refs against the request → build the prompt from
  the *server's* serialized scene + the existing candidate. Invalid scene → existing generic
  rejection, never reaches Qwen. Deterministic `/plan` ignores `scene` (still valid).
- tests: enum bounds / unknown keys / ref mismatch / false-assertion tamper never call the model;
  one valid scene reaches the prompt exactly once; live-Qwen smoke with a scene.

**Slice 2 — extension: discovery, binding, vault, scene** (`extension/content.ts`,
`extension/background.ts`, `extension/config.ts`, `extension/protocol.ts`,
`extension/generated/*`, `extension/manifest.json`, new `extension/vault.ts`,
`extension/field-discovery.ts`):
- `field-discovery.ts` (pure, unit-tested): given a serialisable description of candidate
  inputs, return `{ ok, targetIndex }` or a fail-closed reason. No DOM in the tested unit.
- `content.ts`: replace `getField()`'s fixed-URL + `#shipping-address` check with
  `field-discovery` over real inputs; keep all freshness/rect/version machinery. `OBSERVE`
  returns the field role + `state` + a `textPresence`-ready detector hook is not here (vision
  stays in the popup) — `content.ts` reports only field facts.
- `background.ts`: drop `FIXTURE_URL` exact match from `start()`/`current()`; bind to the
  observed `tabId` + `documentId` + origin + version (origin now variable, still pinned per
  task). Build `scene` from trusted state after `VISION` ok, using the real detector result for
  `localVision.textPresence`. Send `protocol: 2` + `scene`.
- `vault.ts`: `chrome.storage.session` get/set; popup "Saved address" editor; `manifest` gains
  `"storage"`; on a real origin with no vault → withhold.
- `protocol.ts`: `buildPayload` builds + validates the protocol-2 request incl. the ref
  cross-checks; generated validator regenerated.
- tests: `field-discovery` unit matrix (single match / ambiguous / hidden / readonly /
  prefilled / wrong type); scene builder never reads the value.

**Slice 3 — popup + real-site e2e + wire assertions** (`extension/popup.*`,
`tests/e2e/*`, `server/main.py` second fixture route, `web`-free):
- popup: deterministic explanation by planner mode; scene shown in the disclosure panel; vault
  editor.
- new fixture `fixtures/realistic-checkout.html` served at a **distinct path/origin-ish**
  (`/site` — an ordinary-looking multi-field checkout with a real `autocomplete="street-address"`
  field among email/name/city/billing decoys).
- e2e: real-site fill success via the second fixture with a user-set vault address; ambiguous /
  hidden / readonly / prefilled fields each fail closed; navigation + DOM mutation invalidate a
  pending task; the `/plan` request body contains the scene and **none** of: the vault address,
  any fixture OCR string, `data:image`, the page URL/origin, or any `<label>` text; the
  backend→Qwen body likewise; one live-Qwen end-to-end proving the sanitized scene reaches Qwen
  and the action still passes binding/freshness/expiry/one-use.

## Deferred work

Redacted preview images, *arbitrary* autonomous actions, form submission, multi-field or
multi-step flows, additional field kinds, multiple candidates, and free-form model
explanations remain outside this change.
