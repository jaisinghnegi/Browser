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
  "goal": "fill_shipping_address",
  "controls": [
    {
      "target": "field_ref_1",
      "fieldKind": "shipping_address",
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
    "sensitiveRegionsMasked": 1,
    "categories": ["address"],
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
| `goal` | `fill_shipping_address` |
| `fieldKind` | `shipping_address` |
| control `state` | `empty`, `filled` |
| capability `kind` | `address` |
| vision category | `address` |
| allowed action | `fill` |

The initial implementation supports one control, one private capability, at most eight detection categories, and counts from zero through eight. References retain the existing format and must match the authorized binding. Unknown keys and enum values are rejected.

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

## Deferred work

Redacted preview images, arbitrary websites, additional field kinds, multiple candidates, and free-form model explanations remain outside this change.
