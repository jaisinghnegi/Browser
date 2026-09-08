import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs, no type declarations; tested via its actual runtime contract.
import { resolveAction } from '../scripts/vlm-eval/adapter.mjs';

const candidates = [
  { label: 'Shipping address', targetRef: 'target-uuid-1', allowedValueRefs: ['ADDRESS_1'] },
  { label: 'Phone number', targetRef: 'target-uuid-2', allowedValueRefs: ['PHONE_1'] },
];

describe('vlm-eval adapter: resolveAction (synthetic, not wired into server/main.py)', () => {
  it('resolves a fill action to the trusted targetRef, never the model-supplied label', () => {
    const raw = '{"action":"fill","target":"Shipping address","valueRef":"ADDRESS_1"}';
    expect(resolveAction(raw, candidates)).toEqual({ ok: true, action: 'fill', targetRef: 'target-uuid-1', valueRef: 'ADDRESS_1' });
  });

  it('matches labels case-insensitively and trims whitespace', () => {
    const raw = '{"action":"fill","target":"  phone NUMBER  ","valueRef":"PHONE_1"}';
    expect(resolveAction(raw, candidates)).toEqual({ ok: true, action: 'fill', targetRef: 'target-uuid-2', valueRef: 'PHONE_1' });
  });

  it('resolves an abstain action with no candidates needed', () => {
    expect(resolveAction('{"action":"abstain","target":null,"valueRef":null}', [])).toEqual({
      ok: true, action: 'abstain', targetRef: null, valueRef: null,
    });
  });

  it('rejects an unknown target label not in the candidate list', () => {
    const raw = '{"action":"fill","target":"Email address","valueRef":"ADDRESS_1"}';
    expect(resolveAction(raw, candidates)).toEqual({ ok: false, reason: 'unknown-target-label' });
  });

  it('rejects an ambiguous label that matches more than one candidate', () => {
    const dup = [
      { label: 'Address', targetRef: 'target-uuid-a', allowedValueRefs: ['ADDRESS_1'] },
      { label: 'Address', targetRef: 'target-uuid-b', allowedValueRefs: ['ADDRESS_2'] },
    ];
    const raw = '{"action":"fill","target":"Address","valueRef":"ADDRESS_1"}';
    expect(resolveAction(raw, dup)).toEqual({ ok: false, reason: 'ambiguous-target-label' });
  });

  it('rejects a valueRef not authorized for the matched candidate', () => {
    const raw = '{"action":"fill","target":"Shipping address","valueRef":"PHONE_1"}';
    expect(resolveAction(raw, candidates)).toEqual({ ok: false, reason: 'unauthorized-value-ref' });
  });

  it('rejects a response wrapped in markdown code fences (JSON-only contract)', () => {
    const raw = '```json\n{"action":"fill","target":"Shipping address","valueRef":"ADDRESS_1"}\n```';
    expect(resolveAction(raw, candidates)).toEqual({ ok: false, reason: 'not-json-only' });
  });

  it('rejects a response with extra prose around the JSON object', () => {
    const raw = 'Sure, here you go: {"action":"fill","target":"Shipping address","valueRef":"ADDRESS_1"}';
    expect(resolveAction(raw, candidates)).toEqual({ ok: false, reason: 'not-json-only' });
  });

  it('rejects an open schema (extra or missing keys)', () => {
    const raw = '{"action":"fill","target":"Shipping address","valueRef":"ADDRESS_1","script":"alert(1)"}';
    expect(resolveAction(raw, candidates)).toEqual({ ok: false, reason: 'schema-not-closed' });
  });

  it('rejects abstain carrying non-null target/valueRef', () => {
    const raw = '{"action":"abstain","target":"Shipping address","valueRef":null}';
    expect(resolveAction(raw, candidates)).toEqual({ ok: false, reason: 'abstain-with-extra-fields' });
  });

  it('rejects an invalid action value', () => {
    const raw = '{"action":"submit","target":null,"valueRef":null}';
    expect(resolveAction(raw, candidates)).toEqual({ ok: false, reason: 'invalid-action' });
  });

  it('rejects malformed JSON outright', () => {
    expect(resolveAction('{not json}', candidates)).toEqual({ ok: false, reason: 'invalid-json' });
  });
});
