import './generate-contract.mjs';
import { build, context } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// BUILD_OUT_DIR lets a build run into an isolated output directory instead of the shared
// dist/ -- e.g. while a demo server has dist/ loaded live and shouldn't be overwritten mid-use.
// Defaults to 'dist' so the plain `npm run build` behavior is unchanged.
const outDir = process.env.BUILD_OUT_DIR || 'dist';
// BUILD_PORT is substituted into the bundle via esbuild's `define` (a literal, build-time-only
// replacement -- see extension/config.ts and extension/global.d.ts) and into the manifest's
// CSP. Defaults to 8171 unconditionally, so every normal build/demo/production artifact has
// the port fixed exactly as before; only an isolated e2e run opts into a different one, and
// even then the value is baked into that specific build's files, never read at runtime.
const port = Number(process.env.BUILD_PORT || 8171);
// Test-only pacing: an artificial per-region delay in the local preview build so lifecycle
// races are deterministic in e2e. 0 everywhere except the isolated e2e build (dead-code
// eliminated when 0). See extension/global.d.ts.
const previewPaceMs = Number(process.env.BUILD_PREVIEW_PACE_MS || 0);

async function verified(path, sha256) {
  const data = await readFile(path).catch(() => {
    throw new Error(`Run npm run model:download before building (missing ${path}).`);
  });
  if (createHash('sha256').update(data).digest('hex') !== sha256) {
    throw new Error(`Model integrity check failed for ${path}.`);
  }
  return data;
}
await verified('models/text-detector.onnx', 'd2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9');
// Recognizer + dictionary: packaged for the Phase 2 local sanitized preview (extension/preview.ts,
// extension/recognize.ts) -- additive to Phase 1's detector-only gating, never part of the
// outbound payload. See models/README.md for provenance/license/preprocessing.
await verified('models/text-recognizer.onnx', '48fc40f24f6d2a207a2b1091d3437eb3cc3eb6b676dc3ef9c37384005483683b');
await verified('models/text-recognizer-dictionary.txt', '28b2362ad4ab2dc38769aa72feb535e3a9ddb3fd2a7585a05920e6393b1dc7f7');
await mkdir(`${outDir}/vendor`, { recursive: true });
await mkdir(`${outDir}/models`, { recursive: true });
for (const file of ['popup.html', 'popup.css']) await copyFile(`extension/${file}`, `${outDir}/${file}`);
const manifestTemplate = await readFile('extension/manifest.json', 'utf8');
await writeFile(`${outDir}/manifest.json`, manifestTemplate.replaceAll('__PRIVACY_AGENT_PORT__', String(port)));
for (const file of ['text-detector.onnx', 'text-recognizer.onnx', 'text-recognizer-dictionary.txt', 'LICENSE.apache-2.0', 'README.md']) {
  await copyFile(`models/${file}`, `${outDir}/models/${file}`);
}
for (const file of ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  await copyFile(`node_modules/onnxruntime-web/dist/${file}`, `${outDir}/vendor/${file}`);
}
const common = { bundle: true, target: 'chrome120', sourcemap: false, logLevel: 'info',
  define: { PRIVACY_AGENT_PORT: String(port), PREVIEW_PACE_MS: String(previewPaceMs) } };
const configs = [
  { ...common, entryPoints: ['extension/background.ts'], outfile: `${outDir}/background.js`, format: 'esm' },
  { ...common, entryPoints: ['extension/content.ts'], outfile: `${outDir}/content.js`, format: 'iife' },
  { ...common, entryPoints: ['extension/popup.ts'], outfile: `${outDir}/popup.js`, format: 'esm', plugins: [{
    name: 'packaged-ort', setup(builder) {
      builder.onResolve({ filter: /^onnxruntime-web\/wasm$/ }, () => ({ path: './vendor/ort.wasm.min.mjs', external: true }));
    },
  }] },
];
for (const config of configs) {
  if (process.argv.includes('--watch')) { const ctx = await context(config); await ctx.watch(); }
  else await build(config);
}
console.log(`Built to ${outDir}/ (port ${port})`);
