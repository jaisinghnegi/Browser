// Bounded, explicit category patterns -- a direct TypeScript port of scripts/phase2/classify.mjs
// so the extension and the local-only evaluation harness are held to the same contract. Tuned
// only against fixtures/phase2/tuning.json samples (see that file's own comment).
const patterns: Record<string, RegExp> = {
  email: /[A-Za-z0-9._%-]+\s*@\s*[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  phone: /(?:\+?91[\s-]?)?0?\d{4,5}[\s-]?\d{5,6}\b/,
  address: /(?:\d{1,4}\s+[A-Za-z][A-Za-z ,.]{2,60}\d{4,6}\b)|(?:Flat\s*\d+.{0,60}?\d{6}\b)/i,
};

/** Classifies already-canonicalized (whitespace-collapsed) recognized text. Returns the first
 * matching category, or null for genuinely benign text -- not a failure. */
export function classify(text: string): string | null {
  for (const [category, pattern] of Object.entries(patterns)) {
    if (pattern.test(text)) return category;
  }
  return null;
}
