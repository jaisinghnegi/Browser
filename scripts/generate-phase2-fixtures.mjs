// Renders fixtures/phase2/manifest.json into static HTML pages. Pure content generation --
// does not touch extension/** or server/**, and produces no ground truth (that requires
// actually rendering and measuring the page; see measure-phase2-fixtures.mjs).
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const manifest = JSON.parse(await readFile(new URL('../fixtures/phase2/manifest.json', import.meta.url), 'utf8'));

function render(entry) {
  const regions = entry.regions.map((r, i) => {
    const html = escape(r.text).replace(/\n/g, '<br>');
    // The outer div is a block-level line container only (keeps regions from flowing into
    // each other); the ground-truth measurement targets the inline span, whose
    // getClientRects() hugs the actual glyphs -- not the block's full container width.
    return `    <div style="font-size:${entry.fontPx}px; margin: 12px 0;"><span data-gt-id="${i}" data-gt-category="${r.category}">${html}</span></div>`;
  }).join('\n');
  const task = entry.task
    ? `    <form>\n      <label for="shipping-address">Shipping address</label>\n      <input id="shipping-address" type="text" value="">\n    </form>\n`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Phase 2 fixture: ${entry.id}</title>
  <style>body { font-family: system-ui, sans-serif; margin: 24px; }</style>
</head>
<body data-fixture-id="${entry.id}">
  <main>
${regions}
${task}  </main>
</body>
</html>
`;
}

await mkdir(new URL('../fixtures/phase2/pages/', import.meta.url), { recursive: true });
for (const entry of manifest) {
  await writeFile(new URL(`../fixtures/phase2/pages/${entry.id}.html`, import.meta.url), render(entry));
}
console.log(`Rendered ${manifest.length} fixture pages.`);
