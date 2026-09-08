import './generate-contract.mjs';
import { build, context } from 'esbuild';
import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// BUILD_OUT_DIR lets a build run into an isolated output directory instead of the shared
// dist/ -- e.g. while a demo server has dist/ loaded live and shouldn't be overwritten mid-use.
// Defaults to 'dist' so the plain `npm run build` behavior is unchanged.
const outDir = process.env.BUILD_OUT_DIR || 'dist';

const model = await readFile('models/text-detector.onnx').catch(() => {
  throw new Error('Run npm run model:download before building.');
});
if (createHash('sha256').update(model).digest('hex') !== 'd2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9') {
  throw new Error('Model integrity check failed.');
}
await mkdir(`${outDir}/vendor`, { recursive: true });
await mkdir(`${outDir}/models`, { recursive: true });
for (const file of ['manifest.json', 'popup.html', 'popup.css']) await copyFile(`extension/${file}`, `${outDir}/${file}`);
await copyFile('models/text-detector.onnx', `${outDir}/models/text-detector.onnx`);
await copyFile('models/LICENSE.apache-2.0', `${outDir}/models/LICENSE.apache-2.0`);
await copyFile('models/README.md', `${outDir}/models/README.md`);
for (const file of ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  await copyFile(`node_modules/onnxruntime-web/dist/${file}`, `${outDir}/vendor/${file}`);
}
const common = { bundle: true, target: 'chrome120', sourcemap: false, logLevel: 'info' };
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
console.log(`Built to ${outDir}/`);
