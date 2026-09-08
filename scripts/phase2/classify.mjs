// Bounded, explicit category patterns matching the labeled-set spec's §3 templates. Tuned
// only against fixtures/phase2/tuning.json samples; fixtures/phase2/holdout.json is never
// used to adjust these patterns (Phase 2 plan §6's frozen-holdout discipline).
const patterns = {
  email: /[A-Za-z0-9._%-]+\s*@\s*[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  // 10 digits, optionally +91/0-prefixed, optionally split by one space/dash anywhere --
  // covers plain/intl/intlTight/leadingZero/dashed variants and reassembled split fragments.
  phone: /(?:\+?91[\s-]?)?0?\d{4,5}[\s-]?\d{5,6}\b/,
  // US-style: number + street text + trailing zip (comma-separated city/state allowed);
  // IN-style: "Flat N, ... - 6-digit PIN".
  address: /(?:\d{1,4}\s+[A-Za-z][A-Za-z ,.]{2,60}\d{4,6}\b)|(?:Flat\s*\d+.{0,60}?\d{6}\b)/i,
};

/** Classifies already-canonicalized (whitespace-collapsed) recognized text. Returns the first
 * matching category, or null if nothing in the bounded category list matches -- which is the
 * correct outcome for genuinely benign text, not a failure. */
export function classify(text) {
  for (const [category, pattern] of Object.entries(patterns)) {
    if (pattern.test(text)) return category;
  }
  return null;
}
