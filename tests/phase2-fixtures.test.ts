import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const readJson = (path: string) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const sha256 = (path: string) => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');

const manifest = readJson('fixtures/phase2/manifest.json') as Array<{
  id: string; set: 'tuning' | 'holdout'; primaryCategory: string; hardNegative: boolean; benign: boolean;
  regions: Array<{ category: string; text: string; multiline?: boolean }>;
}>;
const tuning = readJson('fixtures/phase2/tuning.json');
const holdout = readJson('fixtures/phase2/holdout.json');

describe('Phase 2 labeled fixture set', () => {
  it('matches the frozen totals: 25 tuning, 19 holdout, 44 total', () => {
    expect(manifest.filter(e => e.set === 'tuning')).toHaveLength(25);
    expect(manifest.filter(e => e.set === 'holdout')).toHaveLength(19);
    expect(manifest).toHaveLength(44);
  });

  it('has no duplicate ground-truth secret string across the whole set', () => {
    const seen = new Map<string, string>();
    for (const entry of manifest) {
      for (const region of entry.regions) {
        const key = region.text.replace(/\s+/g, ' ').trim();
        if (seen.has(key)) throw new Error(`Duplicate secret "${key}" in ${seen.get(key)} and ${entry.id}`);
        seen.set(key, entry.id);
      }
    }
  });

  it('tuning.json and holdout.json content hashes match the fixtures on disk', () => {
    for (const [file, manifestList] of [['tuning.json', tuning], ['holdout.json', holdout]] as const) {
      for (const record of manifestList.fixtures) {
        expect(sha256(`fixtures/phase2/pages/${record.id}.html`), `${file}: ${record.id} html`).toBe(record.htmlSha256);
        expect(sha256(`fixtures/phase2/ground-truth/${record.id}.json`), `${file}: ${record.id} ground truth`)
          .toBe(record.groundTruthSha256);
      }
    }
    expect(tuning.fixtures).toHaveLength(25);
    expect(holdout.fixtures).toHaveLength(19);
  });

  it('every fixture in the manifest has a corresponding frozen split entry, and vice versa', () => {
    const frozenIds = new Set([...tuning.fixtures, ...holdout.fixtures].map((f: { id: string }) => f.id));
    const manifestIds = new Set(manifest.map(e => e.id));
    expect(frozenIds).toEqual(manifestIds);
  });

  it('every ground-truth region has a positive-area measured box and the expected line count', () => {
    for (const entry of manifest) {
      const gt = readJson(`fixtures/phase2/ground-truth/${entry.id}.json`);
      expect(gt.regions).toHaveLength(entry.regions.length);
      gt.regions.forEach((region: { box: { width: number; height: number }; lineBoxes: unknown[]; multiline: boolean }, i: number) => {
        expect(region.box.width, `${entry.id}#${i} box width`).toBeGreaterThan(0);
        expect(region.box.height, `${entry.id}#${i} box height`).toBeGreaterThan(0);
        expect(region.lineBoxes.length, `${entry.id}#${i} line count`).toBe(region.multiline ? 2 : 1);
      });
    }
  });

  it('ambiguous-shaped samples are labeled hardNegative and are never the benign-survival control', () => {
    const ambiguous = manifest.filter(e => e.primaryCategory === 'ambiguous');
    expect(ambiguous.length).toBeGreaterThan(0);
    for (const entry of ambiguous) {
      expect(entry.hardNegative).toBe(true);
      expect(entry.benign).toBe(false);
    }
  });

  it('the benign control set is unambiguous (never labeled hardNegative)', () => {
    const benign = manifest.filter(e => e.benign);
    expect(benign.length).toBeGreaterThan(0);
    for (const entry of benign) expect(entry.hardNegative).toBe(false);
  });
});
