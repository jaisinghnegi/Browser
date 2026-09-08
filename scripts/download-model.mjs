import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

/** Each entry is downloaded and pinned-hash-verified independently, following the same
 * verify-before-and-after-write pattern for every artifact. Phase 2's recognizer/dictionary
 * are pinned here ahead of any code that uses them (design review step 2): downloading them
 * now does not change what the extension does at runtime. */
const artifacts = [
  {
    name: 'text-detector.onnx',
    sha256: 'd2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9',
    url: 'https://huggingface.co/SWHL/RapidOCR/resolve/5e7ff7a3692252dd21f42d8c7fd07b9905a1b114/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx',
  },
  {
    name: 'text-recognizer.onnx',
    sha256: '48fc40f24f6d2a207a2b1091d3437eb3cc3eb6b676dc3ef9c37384005483683b',
    url: 'https://huggingface.co/SWHL/RapidOCR/resolve/5e7ff7a3692252dd21f42d8c7fd07b9905a1b114/PP-OCRv4/ch_PP-OCRv4_rec_infer.onnx',
  },
  {
    name: 'text-recognizer-dictionary.txt',
    sha256: '28b2362ad4ab2dc38769aa72feb535e3a9ddb3fd2a7585a05920e6393b1dc7f7',
    // Pinned to the commit that last touched this file on release/2.7, not the branch head,
    // so the URL can't silently start serving different content later.
    url: 'https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/338ba3ee4a0208cee354cd3b7d2c93b320e0ea54/ppocr/utils/ppocr_keys_v1.txt',
  },
];

const valid = (data, sha256) => createHash('sha256').update(data).digest('hex') === sha256;

for (const { name, sha256, url } of artifacts) {
  const path = new URL(`../models/${name}`, import.meta.url);
  let existing;
  try { existing = await readFile(path); } catch { /* First download. */ }
  if (existing && valid(existing, sha256)) {
    console.log(`Pinned ${name} already verified.`);
    continue;
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${name} download failed: ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (!valid(data, sha256)) throw new Error(`${name} SHA256 mismatch; nothing installed.`);
  await mkdir(new URL('../models/', import.meta.url), { recursive: true });
  await writeFile(path, data);
  console.log(`Verified ${name}: ${data.length} bytes, SHA256 ${sha256}`);
}
