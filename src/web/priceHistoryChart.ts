/** One point in a reward's price history, as returned by the DB layer. */
export interface PriceHistoryPoint {
  t: number;
  cost: number;
}

const WIDTH = 480;
const HEIGHT = 120;
const PADDING = { top: 10, right: 12, bottom: 20, left: 44 };

/**
 * Renders an inline SVG line chart of a reward's price over `[rangeStartMs, rangeEndMs]`.
 * A single series needs no legend (the card title above it already names what's plotted).
 * Embeds the plotted points as a `data-points` JSON attribute so `priceHistoryChart.js`
 * can add a hover crosshair/tooltip without re-deriving the scale server-side.
 * Uses `preserveAspectRatio="none"` so the rendered box always stretches the 480x120
 * viewBox to fill its actual on-screen size — without it, the browser's default
 * "meet" scaling letterboxes the chart (renders it at native size, centered) whenever
 * the box's aspect ratio doesn't match 480:120, which silently breaks the hover math in
 * `priceHistoryChart.js` (it maps pointer position to the chart assuming a 1:1 stretch).
 *
 * @param points - Price history points, any order (sorted internally by time).
 * @param rangeStartMs - Left edge of the x-axis (epoch ms).
 * @param rangeEndMs - Right edge of the x-axis (epoch ms).
 * @returns Self-contained `<svg>` markup, or a "no data yet" placeholder if `points` is empty.
 */
export function renderPriceHistoryChart(points: PriceHistoryPoint[], rangeStartMs: number, rangeEndMs: number): string {
  if (points.length === 0) {
    return `<div class="hint price-history-empty" style="height:${HEIGHT}px;display:flex;align-items:center;justify-content:center;">No price history yet for this range.</div>`;
  }

  const sorted = [...points].sort((a, b) => a.t - b.t);
  const costs = sorted.map((p) => p.cost);
  const minCost = Math.min(...costs);
  const maxCost = Math.max(...costs);
  const isFlat = maxCost === minCost;
  // Guard against a degenerate (flat) range so the line doesn't collapse to the chart's edge.
  const costSpan = isFlat ? 1 : maxCost - minCost;

  const plotLeft = PADDING.left;
  const plotRight = WIDTH - PADDING.right;
  const plotTop = PADDING.top;
  const plotBottom = HEIGHT - PADDING.bottom;
  const timeSpan = Math.max(1, rangeEndMs - rangeStartMs);

  const toX = (t: number) => plotLeft + ((t - rangeStartMs) / timeSpan) * (plotRight - plotLeft);
  const toY = (cost: number) => isFlat
    ? (plotTop + plotBottom) / 2
    : plotBottom - ((cost - minCost) / costSpan) * (plotBottom - plotTop);

  const pixelPoints = sorted.map((p) => ({ x: toX(p.t), y: toY(p.cost), t: p.t, cost: p.cost }));
  const polyline = pixelPoints.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const last = pixelPoints[pixelPoints.length - 1];

  const dataPoints = JSON.stringify(sorted.map((p) => [p.t, p.cost]));

  return `
<svg class="price-history-chart" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="100%" height="${HEIGHT}" preserveAspectRatio="none"
     data-points='${dataPoints.replace(/'/g, '&#39;')}'
     data-plot-left="${plotLeft}" data-plot-right="${plotRight}"
     data-range-start="${rangeStartMs}" data-range-end="${rangeEndMs}"
     role="img" aria-label="Price history from ${new Date(rangeStartMs).toLocaleString()} to ${new Date(rangeEndMs).toLocaleString()}, ranging from ${minCost} to ${maxCost} points">
  <line x1="${plotLeft}" y1="${toY(maxCost).toFixed(1)}" x2="${plotRight}" y2="${toY(maxCost).toFixed(1)}" stroke="var(--border)" stroke-width="1"/>
  <line x1="${plotLeft}" y1="${toY(minCost).toFixed(1)}" x2="${plotRight}" y2="${toY(minCost).toFixed(1)}" stroke="var(--border)" stroke-width="1"/>
  <text x="${plotLeft - 6}" y="${toY(maxCost).toFixed(1)}" dy="0.32em" text-anchor="end" class="price-history-tick">${maxCost.toLocaleString()}</text>
  <text x="${plotLeft - 6}" y="${toY(minCost).toFixed(1)}" dy="0.32em" text-anchor="end" class="price-history-tick">${minCost.toLocaleString()}</text>
  <polyline points="${polyline}" fill="none" stroke="var(--primary)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
  <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="4" fill="var(--primary)" stroke="var(--bg-card)" stroke-width="2"/>
  <text x="${last.x.toFixed(1)}" y="${(last.y - 8).toFixed(1)}" text-anchor="end" class="price-history-end-label">${last.cost.toLocaleString()} pts</text>
  <g class="price-history-crosshair" style="display:none;">
    <line class="price-history-crosshair-line" y1="${plotTop}" y2="${plotBottom}" stroke="var(--muted)" stroke-width="1"/>
    <circle class="price-history-crosshair-dot" r="4" fill="var(--primary)" stroke="var(--bg-card)" stroke-width="2"/>
  </g>
</svg>`.trim();
}
