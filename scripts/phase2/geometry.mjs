// Pure-JS connected-component grouping over a thresholded detector map. No image library
// needed: this operates on the flat Float32Array probability map returned by ONNX inference.

/** 8-connectivity flood fill over `mask` (Uint8Array, 1 = above threshold), returning one
 * axis-aligned bounding box per connected component in map-space pixel coordinates.
 * Simplification, documented: a true minimum-area-rotated-rect is not implemented here --
 * this fixture set has no rotated text, so axis-aligned boxes are adequate for this
 * local-only prototype; rotation support is future work if unseen-layout testing needs it. */
export function connectedComponents(mask, width, height) {
  const visited = new Uint8Array(width * height);
  const components = [];
  const stack = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    let minX = width, minY = height, maxX = -1, maxY = -1, count = 0;
    stack.push(start);
    visited[start] = 1;
    while (stack.length) {
      const idx = stack.pop();
      const x = idx % width, y = (idx / width) | 0;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      count++;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const nIdx = ny * width + nx;
        if (mask[nIdx] && !visited[nIdx]) { visited[nIdx] = 1; stack.push(nIdx); }
      }
    }
    components.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, pixelCount: count });
  }
  return components;
}

const overlaps1d = (aStart, aLen, bStart, bLen, gap = 0) =>
  aStart - gap <= bStart + bLen && bStart - gap <= aStart + aLen;

/** Merges fine-grained components into lines: same vertical band, horizontally close. */
export function groupIntoLines(components, { yGap = 4, xGap = 12 } = {}) {
  const remaining = [...components];
  const lines = [];
  while (remaining.length) {
    let group = [remaining.shift()];
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = remaining.length - 1; i >= 0; i--) {
        const c = remaining[i];
        const fits = group.some(g =>
          overlaps1d(g.y, g.height, c.y, c.height, yGap * 0.5) && overlaps1d(g.x, g.width, c.x, c.width, xGap));
        if (fits) { group.push(c); remaining.splice(i, 1); grew = true; }
      }
    }
    const x = Math.min(...group.map(g => g.x)), y = Math.min(...group.map(g => g.y));
    const maxX = Math.max(...group.map(g => g.x + g.width)), maxY = Math.max(...group.map(g => g.y + g.height));
    lines.push({ x, y, width: maxX - x, height: maxY - y, parts: group.length });
  }
  return lines;
}

/** Merges lines into blocks: vertically adjacent within a small gap (multiline addresses,
 * a name directly above/below an address, split fragments rendered as stacked lines),
 * reasonably overlapping horizontally so unrelated text on the same page isn't merged. */
export function groupIntoBlocks(lines, { blockGap = 20, minXOverlapFrac = 0.2 } = {}) {
  const remaining = [...lines].sort((a, b) => a.y - b.y);
  const blocks = [];
  while (remaining.length) {
    let group = [remaining.shift()];
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = remaining.length - 1; i >= 0; i--) {
        const c = remaining[i];
        const fits = group.some(g => {
          const verticallyClose = overlaps1d(g.y, g.height, c.y, c.height, blockGap);
          const overlapWidth = Math.min(g.x + g.width, c.x + c.width) - Math.max(g.x, c.x);
          const minWidth = Math.min(g.width, c.width);
          return verticallyClose && (minWidth === 0 || overlapWidth / minWidth >= minXOverlapFrac || overlapWidth > 0);
        });
        if (fits) { group.push(c); remaining.splice(i, 1); grew = true; }
      }
    }
    const x = Math.min(...group.map(g => g.x)), y = Math.min(...group.map(g => g.y));
    const maxX = Math.max(...group.map(g => g.x + g.width)), maxY = Math.max(...group.map(g => g.y + g.height));
    blocks.push({ x, y, width: maxX - x, height: maxY - y, lines: group.sort((a, b) => a.y - b.y) });
  }
  return blocks;
}

/** Expands a box outward by a fixed margin -- detector masks characteristically shrink
 * slightly inside true glyph boundaries (Phase 2 plan §3); compensates so a redaction box
 * doesn't clip edge pixels of the real text. */
export function expandBox(box, margin) {
  return { x: box.x - margin, y: box.y - margin, width: box.width + margin * 2, height: box.height + margin * 2 };
}
