import './generate-contract.mjs';
import { build, context } from 'esbuild';
import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const model = await readFile('models/text-detector.onnx').catch(() => {
  throw new Error('Run npm run model:download before building.');
});
if (createHash('sha256').update(model).digest('hex') !== 'd2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9') {
  throw new Error('Model integrity check failed.');
}
await mkdir('dist/vendor', { recursive: true });
await mkdir('dist/models', { recursive: true });
for (const file of ['manifest.json', 'popup.html', 'popup.css']) await copyFile(`extension/${file}`, `dist/${file}`);
await copyFile('models/text-detector.onnx', 'dist/models/text-detector.onnx');
await copyFile('models/LICENSE.apache-2.0', 'dist/models/LICENSE.apache-2.0');
await copyFile('models/README.md', 'dist/models/README.md');
for (const file of ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  await copyFile(`node_modules/onnxruntime-web/dist/${file}`, `dist/vendor/${file}`);
}
const common = { bundle: true, target: 'chrome120', sourcemap: false, logLevel: 'info' };
const configs = [
  { ...common, entryPoints: ['extension/background.ts'], outfile: 'dist/background.js', format: 'esm' },
  { ...common, entryPoints: ['extension/content.ts'], outfile: 'dist/content.js', format: 'iife' },
  { ...common, entryPoints: ['extension/popup.ts'], outfile: 'dist/popup.js', format: 'esm', plugins: [{
    name: 'packaged-ort', setup(builder) {
      builder.onResolve({ filter: /^onnxruntime-web\/wasm$/ }, () => ({ path: './vendor/ort.wasm.min.mjs', external: true }));
    },
  }] },
];
for (const config of configs) {
  if (process.argv.includes('--watch')) { const ctx = await context(config); await ctx.watch(); }
  else await build(config);
}
