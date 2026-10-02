// Use observed scroll positions: requested offsets do not prove that a page
// scrolled, and deferred layout can grow after the initial tile count is chosen.
export function uncoveredRanges(tiles, phase, viewportHeight, documentHeight) {
  const ranges = tiles.map((tile) => tile[`${phase}ScrollY`])
    .filter(Number.isFinite).map((y) => [Math.max(0, y), y + viewportHeight])
    .sort((a, b) => a[0] - b[0]);
  const gaps = [];
  let end = 0;
  for (const [start, stop] of ranges) {
    if (start > end + 1) gaps.push([end, Math.min(start, documentHeight)]);
    end = Math.max(end, stop);
  }
  if (end < documentHeight - 1) gaps.push([end, documentHeight]);
  return gaps.filter(([start, stop]) => stop > start + 1);
}

export function missingFrames(before, after) {
  return before.filter((frame) => !after.some((current) => current.index === frame.index && current.url === frame.url));
}
