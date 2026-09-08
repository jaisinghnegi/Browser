// Backend adapter groundwork (synthetic inputs only -- NOT wired into server/main.py, which
// keeps its tested deterministic planner unchanged). This is the trust boundary between a raw
// model response and any action the browser would ever execute: the model's free-text
// `target` label is NEVER itself an executable reference. It is only ever used to look up one
// pre-authorized candidate from a bounded list the caller supplies (standing in for what a
// real observation/binding step would provide) -- the actual `targetRef` returned is always
// the trusted value from that candidate, never anything the model invented.
//
// candidates: [{ label: string, targetRef: string, allowedValueRefs: string[] }]

const CLOSED_KEYS = JSON.stringify(['action', 'target', 'valueRef']);

/** @returns {{ ok: true, action: 'fill', targetRef: string, valueRef: string }
 *          | { ok: true, action: 'abstain', targetRef: null, valueRef: null }
 *          | { ok: false, reason: string } } */
export function resolveAction(rawText, candidates) {
  if (typeof rawText !== 'string') return { ok: false, reason: 'no-response' };
  const trimmed = rawText.trim();
  // Strict: the adapter's contract is JSON-only, no markdown fences, no surrounding prose --
  // tighter than merely "extractable", since a real caller can't safely guess at intent.
  if (!/^\{[\s\S]*\}$/.test(trimmed)) return { ok: false, reason: 'not-json-only' };

  let parsed;
  try { parsed = JSON.parse(trimmed); } catch { return { ok: false, reason: 'invalid-json' }; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid-json' };
  }
  if (JSON.stringify(Object.keys(parsed).sort()) !== CLOSED_KEYS) return { ok: false, reason: 'schema-not-closed' };
  if (!['fill', 'abstain'].includes(parsed.action)) return { ok: false, reason: 'invalid-action' };

  if (parsed.action === 'abstain') {
    if (parsed.target !== null || parsed.valueRef !== null) return { ok: false, reason: 'abstain-with-extra-fields' };
    return { ok: true, action: 'abstain', targetRef: null, valueRef: null };
  }

  // action === 'fill'
  if (typeof parsed.target !== 'string' || typeof parsed.valueRef !== 'string') {
    return { ok: false, reason: 'fill-missing-fields' };
  }
  const label = parsed.target.trim().toLowerCase();
  const matches = candidates.filter(c => c.label.trim().toLowerCase() === label);
  if (matches.length === 0) return { ok: false, reason: 'unknown-target-label' };
  if (matches.length > 1) return { ok: false, reason: 'ambiguous-target-label' };
  const candidate = matches[0];
  if (!candidate.allowedValueRefs.includes(parsed.valueRef)) return { ok: false, reason: 'unauthorized-value-ref' };

  // The trusted targetRef comes from the candidate list, never from parsed.target directly --
  // this is what makes "no arbitrary execution" true regardless of what string the model wrote.
  return { ok: true, action: 'fill', targetRef: candidate.targetRef, valueRef: parsed.valueRef };
}
