// Renders fixtures/phase2/manifest.json into static HTML pages. Pure content generation --
// does not touch extension/** or server/**, and produces no ground truth (that requires
// actually rendering and measuring the page; see measure-phase2-fixtures.mjs).
//
// Writes two parallel trees with identical visible rendering:
//   fixtures/phase2/pages/          -- the real fixture, no data-gt-* attributes at all. This
//                                      is what any future serving path or detector-evaluation
//                                      code must load. A detector reading `data-gt-category`
//                                      off the DOM would be reading the answer key, not
//                                      detecting anything -- these pages don't have one to read.
//                                      Also has no `data-fixture-id`, for the same reason.
//   fixtures/phase2/pages-labeled/  -- the same content plus `data-gt-*`/`data-fixture-id`
//                                      attributes, used *only* by measure-phase2-fixtures.mjs
//                                      to locate regions for offline ground-truth extraction.
//                                      Nothing else should ever load this tree.
// No CSS in either tree selects on these attributes, so they don't affect layout -- boxes
// measured from pages-labeled/ are valid ground truth for the identically-laid-out pages/.
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const manifest = JSON.parse(await readFile(new URL('../fixtures/phase2/manifest.json', import.meta.url), 'utf8'));

function render(entry, { labeled }) {
  const alt = entry.tags.includes('altLayout');
  const bodyFont = alt ? 'Georgia, "Times New Roman", serif' : 'system-ui, sans-serif';
  const regions = entry.regions.map((r, i) => {
    const html = escape(r.text).replace(/\n/g, '<br>');
    const gtAttrs = labeled ? ` data-gt-id="${i}" data-gt-category="${r.category}"` : '';
    // altLayout also varies line-break/margin structure (not just font), so the fixed set
    // isn't entirely one identical stacked layout -- a centered, narrower, bordered block
    // instead of the default left-aligned full-width stack.
    const wrapperStyle = alt
      ? `font-size:${entry.fontPx}px; margin: 10px auto; max-width: 420px; text-align: center; border: 1px solid #ccc; padding: 8px;`
      : `font-size:${entry.fontPx}px; margin: 12px 0;`;
    return `    <div style="${wrapperStyle}"><span${gtAttrs}>${html}</span></div>`;
  }).join('\n');
  const task = entry.task
    ? `    <form>\n      <label for="shipping-address">Shipping address</label>\n      <input id="shipping-address" type="text" value="">\n    </form>\n`
    : '';
  const bodyAttrs = labeled ? ` data-fixture-id="${entry.id}"` : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Phase 2 fixture: ${entry.id}</title>
  <style>body { font-family: ${bodyFont}; margin: 24px; }</style>
</head>
<body${bodyAttrs}>
  <main>
${regions}
${task}  </main>
</body>
</html>
`;
}

await mkdir(new URL('../fixtures/phase2/pages/', import.meta.url), { recursive: true });
await mkdir(new URL('../fixtures/phase2/pages-labeled/', import.meta.url), { recursive: true });
for (const entry of manifest) {
  await writeFile(new URL(`../fixtures/phase2/pages/${entry.id}.html`, import.meta.url), render(entry, { labeled: false }));
  await writeFile(new URL(`../fixtures/phase2/pages-labeled/${entry.id}.html`, import.meta.url), render(entry, { labeled: true }));
}
console.log(`Rendered ${manifest.length} fixture pages (clean + labeled).`);
