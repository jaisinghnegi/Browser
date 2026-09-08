import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
export const modelSha256 = 'd2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9';
export const modelPath = new URL('../models/text-detector.onnx', import.meta.url);
const url = 'https://huggingface.co/SWHL/RapidOCR/resolve/5e7ff7a3692252dd21f42d8c7fd07b9905a1b114/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx';
const valid = data => createHash('sha256').update(data).digest('hex') === modelSha256;
let existing;
try { existing = await readFile(modelPath); } catch { /* First download. */ }
if (existing && valid(existing)) {
  console.log('Pinned model already verified.');
} else {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Model download failed: ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (!valid(data)) throw new Error('Model SHA256 mismatch; nothing installed.');
  await mkdir(new URL('../models/', import.meta.url), { recursive: true });
  await writeFile(modelPath, data);
  console.log(`Verified model: ${data.length} bytes, SHA256 ${modelSha256}`);
}
