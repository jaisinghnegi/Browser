// Independent leakage/utility evaluation of detect.mjs's output against the frozen ground
// truth, per the labeled-set spec §7's oracle contract: every ground-truth region/fragment
// (including name-in-address) must be visually covered by an opaque mask in the pipeline's
// own redacted image, regardless of whether the pipeline's own classifier agreed it was
// sensitive. This script does not trust detect.mjs's self-reported "masked" claims -- it
// re-reads the actual redacted PNG pixels at each ground-truth box.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openImageOpsPage, closeImageOps, readImageRegionPixels } from './image-ops.mjs';

const root = new URL('../../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('fixtures/phase2/manifest.json', root), 'utf8'));
const pipelineOutput = JSON.parse(await readFile(new URL('fixtures/phase2/results/pipeline-output.json', root), 'utf8'));
const byId = Object.fromEntries(pipelineOutput.map(r => [r.id, r]));

const page = await openImageOpsPage();

/** A pixel counts as "still exposed" if it isn't the opaque mask fill color drawRedactedImage
 * uses (#000000, alpha 255). Anti-aliased edges of the mask box are excluded from the
 * "leaked" verdict only if the whole box's *interior* (a 2px-inset core) is solid -- this
 * tolerates the mask box's own edge blending against a white background without accepting a
 * box that merely grazes the ground-truth region. */
function isFullyMasked(pixels) {
  const { width, height, data } = pixels;
  if (width <= 4 || height <= 4) {
    // Region too small to inset; require every pixel opaque-black.
    for (let i = 0; i < data.length; i += 4) {
      if (!(data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 255)) return false;
    }
    return true;
  }
  for (let y = 2; y < height - 2; y++) for (let x = 2; x < width - 2; x++) {
    const i = (y * width + x) * 4;
    if (!(data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 255)) return false;
  }
  return true;
}

const results = [];
for (const entry of manifest) {
  const gt = JSON.parse(await readFile(new URL(`fixtures/phase2/ground-truth/${entry.id}.json`, root), 'utf8'));
  const pipeline = byId[entry.id];
  const dpr = gt.referenceViewport.devicePixelRatio;

  if (!pipeline || pipeline.status !== 'processed') {
    // Fail-closed: nothing was uploaded, so nothing is exposed -- but no utility either.
    results.push({ id: entry.id, outcome: 'withheld', regions: gt.regions.map(r => ({ category: r.category, exposed: false })) });
    continue;
  }

  const redactedPath = fileURLToPath(new URL(`fixtures/phase2/results/${entry.id}-redacted.png`, root));
  const redactedBuf = await readFile(redactedPath);
  const redactedDataUrl = `data:image/png;base64,${redactedBuf.toString('base64')}`;

  const regionResults = [];
  for (const region of gt.regions) {
    // Ground truth is CSS pixels at the declared reference viewport; the screenshot (and its
    // redacted copy) is physical pixels at that viewport's DPR -- scale before comparing.
    let exposedAnyLine = false;
    for (const line of region.lineBoxes) {
      const physicalBox = { x: line.x * dpr, y: line.y * dpr, width: line.width * dpr, height: line.height * dpr };
      const pixels = await readImageRegionPixels(page, redactedDataUrl, physicalBox);
      if (!isFullyMasked(pixels)) exposedAnyLine = true;
    }
    regionResults.push({ category: region.category, text: region.text, groupId: region.groupId, exposed: exposedAnyLine });
  }
  results.push({ id: entry.id, outcome: 'processed', maskedRegionCount: pipeline.maskedRegionCount, regions: regionResults });
}
await page.close();
await closeImageOps();

// --- Aggregate report ---
const byCategory = {};
for (const r of results) for (const region of r.regions) {
  const cat = region.category;
  byCategory[cat] ??= { total: 0, exposed: 0 };
  byCategory[cat].total++;
  if (region.exposed) byCategory[cat].exposed++;
}

const bySet = { tuning: { total: 0, exposed: 0 }, holdout: { total: 0, exposed: 0 } };
for (const entry of manifest) {
  const r = results.find(x => x.id === entry.id);
  for (const region of r.regions) {
    bySet[entry.set].total++;
    if (region.exposed) bySet[entry.set].exposed++;
  }
}

const ambiguousMasked = manifest.filter(e => e.hardNegative)
  .map(e => ({ id: e.id, masked: (byId[e.id]?.maskedRegionCount ?? 0) > 0 }));
const ambiguousMaskRate = ambiguousMasked.filter(a => a.masked).length / ambiguousMasked.length;

const benignEntries = manifest.filter(e => e.benign);
const benignUtility = benignEntries.map(e => ({ id: e.id, maskedRegionCount: byId[e.id]?.maskedRegionCount ?? 0 }));
const benignFalsePositiveRate = benignUtility.filter(b => b.maskedRegionCount > 0).length / benignUtility.length;

// Only these categories are real secrets requiring redaction; "ambiguous" and "benign" are
// deliberately left unmasked by design in most cases (ambiguous exposure is a utility-cost
// signal, not a leak -- see ambiguousShapedMaskRate; benign exposure is the whole point of
// selective redaction working, tracked via benignFalsePositiveRate instead). Never silently
// drop a genuine secret category from this list merely because a *different* sample happens
// to be ambiguous -- name-in-address stays in scope exactly like address/phone/email.
const REQUIRED_SECRET_CATEGORIES = new Set(['address', 'phone', 'email', 'name-in-address']);
const anyExposed = results.some(r => r.regions.some(reg => reg.exposed && REQUIRED_SECRET_CATEGORIES.has(reg.category)));

const requiredByCategory = Object.fromEntries(
  Object.entries(byCategory).filter(([cat]) => REQUIRED_SECRET_CATEGORIES.has(cat)));
// Named explicitly as *regions*, not samples: one address/phone/email sample can carry more
// than one required-secret region (an address sample's own address region plus an adjacent
// name-in-address region; a split sample's two fragment regions). Region and sample counts are
// reported separately below so neither is mistaken for the other.
const requiredRegionsBySet = { tuning: { total: 0, exposed: 0 }, holdout: { total: 0, exposed: 0 } };
for (const entry of manifest) {
  const r = results.find(x => x.id === entry.id);
  for (const region of r.regions) if (REQUIRED_SECRET_CATEGORIES.has(region.category)) {
    requiredRegionsBySet[entry.set].total++;
    if (region.exposed) requiredRegionsBySet[entry.set].exposed++;
  }
}

// Sample-level denominators (a "sample" = one fixture/manifest entry = one row in
// tuning.json/holdout.json), distinct from the region-level counts above.
const samplesBySet = { tuning: { total: 0, secretBearing: 0, processed: 0, withheld: 0 },
  holdout: { total: 0, secretBearing: 0, processed: 0, withheld: 0 } };
for (const entry of manifest) {
  const r = results.find(x => x.id === entry.id);
  samplesBySet[entry.set].total++;
  if (!entry.benign && !entry.hardNegative) samplesBySet[entry.set].secretBearing++;
  samplesBySet[entry.set][r.outcome === 'processed' ? 'processed' : 'withheld']++;
}
const affectedSamples = results
  .filter(r => r.regions.some(reg => reg.exposed && REQUIRED_SECRET_CATEGORIES.has(reg.category)))
  .map(r => r.id);

// Measured per-fixture stage timings from detect.mjs, reported as-is (no attribution of the
// gap between this and Phase 1's in-browser ~20ms detector figure -- that would need actual
// profiling this harness hasn't done, not an assumption that it's IPC/decode overhead).
const timed = pipelineOutput.filter(r => r.timingMs);
const stats = values => values.length
  ? { mean: values.reduce((a, b) => a + b, 0) / values.length, max: Math.max(...values), min: Math.min(...values) }
  : null;
const latencyMs = {
  sampleCount: timed.length,
  detect: stats(timed.filter(r => r.timingMs.detect !== undefined).map(r => r.timingMs.detect)),
  recognize: stats(timed.filter(r => r.timingMs.recognize !== undefined).map(r => r.timingMs.recognize)),
  total: stats(timed.map(r => r.timingMs.total)),
};

const report = {
  // This harness's own measured latency (Node + Playwright IPC to a real headless Chromium
  // page for every image op, plus in-process ONNX inference) -- not in-extension performance.
  latencyMs,
  // --- Sample-level (one row per fixture/manifest entry; matches tuning.json/holdout.json) ---
  totalSamples: manifest.length,
  samplesBySet, // { tuning: {total, secretBearing, processed, withheld}, holdout: {...} }
  fixturesProcessed: results.filter(r => r.outcome === 'processed').length,
  fixturesWithheld: results.filter(r => r.outcome === 'withheld').length,
  // Samples (not regions) with at least one exposed required-secret region -- 2 samples can
  // still mean 3 exposed regions if one sample has more than one (e.g. a split fragment pair).
  affectedSampleIds: affectedSamples,
  affectedSampleCount: affectedSamples.length,

  // --- Region-level (a sample can carry >1 ground-truth region: address+name-in-address,
  // split fragments, or a mixed-category page's extra regions) ---
  requiredSecretRegionsByCategory: requiredByCategory, // { address: {total, exposed}, ... }
  requiredSecretRegionsBySet: requiredRegionsBySet, // { tuning: {total, exposed}, holdout: {...} }
  requiredSecretRegionsExposedTotal: requiredRegionsBySet.tuning.exposed + requiredRegionsBySet.holdout.exposed,

  overallLeakageFound: anyExposed,
  // Non-privacy signals, reported separately so neither can be mistaken for the other:
  ambiguousShapedMaskRate: ambiguousMaskRate, // utility cost of conservative masking, not a leak metric
  benignFalsePositiveRate, // over-redaction cost on content with nothing to protect
  leakageByCategoryAllGroups: byCategory, // regions, includes ambiguous/benign for full transparency
  leakageBySetAllGroups: bySet, // regions
  exposedRegionDetails: results.flatMap(r => r.regions.filter(reg => reg.exposed).map(reg => ({
    fixture: r.id, category: reg.category, text: reg.text,
    requiredSecret: REQUIRED_SECRET_CATEGORIES.has(reg.category),
  }))),
};

await writeFile(fileURLToPath(new URL('fixtures/phase2/results/leakage-report.json', root)), JSON.stringify({ results, report }, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
