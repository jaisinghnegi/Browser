// CTC greedy decode against the pinned PP-OCRv4 recognizer's confirmed output contract
// (models/README.md): [1, T, 6625] already-softmaxed probabilities, class 0 = CTC blank,
// classes 1..6623 = the dictionary in order, class 6624 = PaddleOCR's trailing space class.
import { readFile } from 'node:fs/promises';

export async function loadDictionary(path) {
  const text = await readFile(path, 'utf8');
  return text.split(/\r?\n/).filter(line => line.length > 0);
}

/** `probs` is the flat [T, numClasses] Float32Array/array (batch dim already stripped). */
export function ctcGreedyDecode(probs, timesteps, numClasses, dictionary) {
  let prev = -1;
  const chars = [];
  const confidences = [];
  for (let t = 0; t < timesteps; t++) {
    let best = 0, bestP = -Infinity;
    for (let c = 0; c < numClasses; c++) {
      const p = probs[t * numClasses + c];
      if (p > bestP) { bestP = p; best = c; }
    }
    if (best !== 0 && best !== prev) {
      chars.push(best === numClasses - 1 ? ' ' : (dictionary[best - 1] ?? ''));
      confidences.push(bestP);
    }
    prev = best;
  }
  const text = chars.join('');
  const meanConfidence = confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0;
  return { text, meanConfidence };
}
