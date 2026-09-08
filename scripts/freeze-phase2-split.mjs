// Writes fixtures/phase2/tuning.json and holdout.json: the frozen file list + content hashes
// for each set, computed after all 44 fixtures/ground-truth exist and before any threshold
// tuning starts. This file's existence in the commit *is* the evidence the freeze happened
// before tuning, not an after-the-fact claim.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const manifest = JSON.parse(await readFile(new URL('../fixtures/phase2/manifest.json', import.meta.url), 'utf8'));
const hashOf = async path => createHash('sha256').update(await readFile(path)).digest('hex');

const bySet = { tuning: [], holdout: [] };
for (const entry of manifest) {
  const htmlPath = new URL(`../fixtures/phase2/pages/${entry.id}.html`, import.meta.url);
  const gtPath = new URL(`../fixtures/phase2/ground-truth/${entry.id}.json`, import.meta.url);
  bySet[entry.set].push({
    id: entry.id,
    primaryCategory: entry.primaryCategory,
    hardNegative: entry.hardNegative,
    benign: entry.benign,
    htmlSha256: await hashOf(htmlPath),
    groundTruthSha256: await hashOf(gtPath),
  });
}

for (const set of ['tuning', 'holdout']) {
  await writeFile(new URL(`../fixtures/phase2/${set}.json`, import.meta.url), JSON.stringify({
    set, frozenAt: 'commit that introduces this file', count: bySet[set].length, fixtures: bySet[set],
  }, null, 2) + '\n');
  console.log(`${set}: ${bySet[set].length} fixtures`);
}
