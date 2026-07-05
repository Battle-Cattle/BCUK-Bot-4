/**
 * Finds the data point nearest to a given time value.
 * @param {Array<[number, number]>} points - `[time, cost]` pairs, sorted ascending by time.
 * @param {number} targetT - The time to find the nearest point to.
 * @returns {[number, number] | undefined} The nearest point, or undefined if `points` is empty.
 */
function findNearestPoint(points, targetT) {
  let nearest = points[0];
  let nearestDelta = Infinity;
  for (const point of points) {
    const delta = Math.abs(point[0] - targetT);
    if (delta < nearestDelta) {
      nearest = point;
      nearestDelta = delta;
    }
  }
  return nearest;
}

/**
 * Formats an epoch-ms timestamp as a short local time string for the tooltip.
 * @param {number} t - Epoch ms.
 * @returns {string} Formatted time, e.g. "2:34 PM".
 */
function formatTooltipTime(t) {
  return new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * Updates a chart's crosshair line/dot and tooltip to the nearest point at a given
 * client X position, or hides them when `clientX` is null.
 * @param {SVGSVGElement} svg - The chart's root SVG element.
 * @param {HTMLElement} tooltip - The floating tooltip element to position/fill.
 * @param {number | null} clientX - Pointer X in viewport coordinates, or null to hide.
 * @returns {void}
 */
function updateCrosshair(svg, tooltip, clientX) {
  const crosshair = svg.querySelector('.price-history-crosshair');
  if (clientX === null) {
    if (crosshair) crosshair.style.display = 'none';
    tooltip.style.display = 'none';
    return;
  }

  const points = JSON.parse(svg.dataset.points || '[]');
  if (points.length === 0) return;

  const rect = svg.getBoundingClientRect();
  const viewBoxWidth = svg.viewBox.baseVal.width || 480;
  const plotLeft = Number(svg.dataset.plotLeft);
  const plotRight = Number(svg.dataset.plotRight);
  const rangeStart = Number(svg.dataset.rangeStart);
  const rangeEnd = Number(svg.dataset.rangeEnd);

  const svgX = ((clientX - rect.left) / rect.width) * viewBoxWidth;
  const clampedX = Math.min(plotRight, Math.max(plotLeft, svgX));
  const targetT = rangeStart + ((clampedX - plotLeft) / (plotRight - plotLeft)) * (rangeEnd - rangeStart);

  const [t, cost] = findNearestPoint(points, targetT);
  const pointX = plotLeft + ((t - rangeStart) / (rangeEnd - rangeStart)) * (plotRight - plotLeft);

  if (crosshair) {
    crosshair.style.display = '';
    const line = crosshair.querySelector('.price-history-crosshair-line');
    const dot = crosshair.querySelector('.price-history-crosshair-dot');
    if (line) { line.setAttribute('x1', String(pointX)); line.setAttribute('x2', String(pointX)); }
    if (dot) dot.setAttribute('cx', String(pointX));
  }

  tooltip.textContent = '';
  const valueEl = document.createElement('strong');
  valueEl.textContent = `${cost.toLocaleString()} pts`;
  const timeEl = document.createElement('span');
  timeEl.textContent = ` — ${formatTooltipTime(t)}`;
  tooltip.appendChild(valueEl);
  tooltip.appendChild(timeEl);
  tooltip.style.display = '';
  tooltip.style.left = `${clientX + 12}px`;
  tooltip.style.top = `${rect.top + window.scrollY - 8}px`;
}

/** Lazily created shared tooltip element, reused across all charts on the page. */
let sharedTooltip = null;

/**
 * Wires up hover/focus crosshair+tooltip behavior for a single chart SVG.
 * @param {SVGSVGElement} svg - The chart's root SVG element.
 * @returns {void}
 */
function wireChartInteractivity(svg) {
  if (!sharedTooltip) {
    sharedTooltip = document.createElement('div');
    sharedTooltip.className = 'price-history-tooltip';
    sharedTooltip.style.display = 'none';
    document.body.appendChild(sharedTooltip);
  }
  svg.addEventListener('pointermove', (event) => updateCrosshair(svg, sharedTooltip, event.clientX));
  svg.addEventListener('pointerleave', () => updateCrosshair(svg, sharedTooltip, null));
}

/** Wires up hover/focus crosshair+tooltip behavior for every `.price-history-chart` on the page. */
function initPriceHistoryCharts() {
  document.querySelectorAll('.price-history-chart').forEach(wireChartInteractivity);
}

// ─── Live updates (Server-Sent Events) ─────────────────────────────────────

const CHART_WIDTH = 480;
const CHART_HEIGHT = 120;
const CHART_PADDING = { top: 10, right: 12, bottom: 20, left: 44 };

/**
 * Builds the inner markup for a reward's price history chart from a set of points, mirroring
 * `renderPriceHistoryChart` in `src/web/priceHistoryChart.ts` (duplicated here since the SSE
 * live-update path redraws entirely client-side, with no shared server/browser code path).
 * @param {Array<[number, number]>} points - `[time, cost]` pairs, any order.
 * @param {number} rangeStartMs - Left edge of the x-axis (epoch ms).
 * @param {number} rangeEndMs - Right edge of the x-axis (epoch ms).
 * @returns {string} Self-contained `<svg>` markup, or a "no data yet" placeholder if empty.
 */
function buildPriceHistoryChartMarkup(points, rangeStartMs, rangeEndMs) {
  if (points.length === 0) {
    return `<div class="hint price-history-empty" style="height:${CHART_HEIGHT}px;display:flex;align-items:center;justify-content:center;">No price history yet for this range.</div>`;
  }

  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  const costs = sorted.map((p) => p[1]);
  const minCost = Math.min(...costs);
  const maxCost = Math.max(...costs);
  const isFlat = maxCost === minCost;
  const costSpan = isFlat ? 1 : maxCost - minCost;

  const plotLeft = CHART_PADDING.left;
  const plotRight = CHART_WIDTH - CHART_PADDING.right;
  const plotTop = CHART_PADDING.top;
  const plotBottom = CHART_HEIGHT - CHART_PADDING.bottom;
  const timeSpan = Math.max(1, rangeEndMs - rangeStartMs);

  const toX = (t) => plotLeft + ((t - rangeStartMs) / timeSpan) * (plotRight - plotLeft);
  const toY = (cost) => (isFlat
    ? (plotTop + plotBottom) / 2
    : plotBottom - ((cost - minCost) / costSpan) * (plotBottom - plotTop));

  const pixelPoints = sorted.map((p) => ({ x: toX(p[0]), y: toY(p[1]) }));
  const polyline = pixelPoints.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const last = pixelPoints[pixelPoints.length - 1];
  const lastCost = sorted[sorted.length - 1][1];

  const dataPoints = JSON.stringify(sorted).replace(/'/g, '&#39;');

  return `
<svg class="price-history-chart" viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" width="100%" height="${CHART_HEIGHT}"
     data-points='${dataPoints}'
     data-plot-left="${plotLeft}" data-plot-right="${plotRight}"
     data-range-start="${rangeStartMs}" data-range-end="${rangeEndMs}"
     role="img" aria-label="Price history from ${new Date(rangeStartMs).toLocaleString()} to ${new Date(rangeEndMs).toLocaleString()}, ranging from ${minCost} to ${maxCost} points">
  <line x1="${plotLeft}" y1="${toY(maxCost).toFixed(1)}" x2="${plotRight}" y2="${toY(maxCost).toFixed(1)}" stroke="var(--border)" stroke-width="1"/>
  <line x1="${plotLeft}" y1="${toY(minCost).toFixed(1)}" x2="${plotRight}" y2="${toY(minCost).toFixed(1)}" stroke="var(--border)" stroke-width="1"/>
  <text x="${plotLeft - 6}" y="${toY(maxCost).toFixed(1)}" dy="0.32em" text-anchor="end" class="price-history-tick">${maxCost.toLocaleString()}</text>
  <text x="${plotLeft - 6}" y="${toY(minCost).toFixed(1)}" dy="0.32em" text-anchor="end" class="price-history-tick">${minCost.toLocaleString()}</text>
  <polyline points="${polyline}" fill="none" stroke="var(--primary)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
  <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="4" fill="var(--primary)" stroke="var(--bg-card)" stroke-width="2"/>
  <text x="${last.x.toFixed(1)}" y="${(last.y - 8).toFixed(1)}" text-anchor="end" class="price-history-end-label">${lastCost.toLocaleString()} pts</text>
  <g class="price-history-crosshair" style="display:none;">
    <line class="price-history-crosshair-line" y1="${plotTop}" y2="${plotBottom}" stroke="var(--muted)" stroke-width="1"/>
    <circle class="price-history-crosshair-dot" r="4" fill="var(--primary)" stroke="var(--bg-card)" stroke-width="2"/>
  </g>
</svg>`.trim();
}

/**
 * Applies a live price/demand point pushed over SSE to one reward's chart card: appends the
 * point (sliding the visible window forward to "now"), redraws the chart, and updates the
 * demand/price text next to it.
 * @param {{rewardId: string, cost: number, demand: number, recordedAt: number}} event - The pushed update.
 * @returns {void}
 */
function applyLivePricingUpdate(event) {
  const container = document.querySelector(`.price-history-container[data-reward-id="${CSS.escape(event.rewardId)}"]`);
  if (!container) return;

  const existingSvg = container.querySelector('.price-history-chart');
  const existingPoints = existingSvg ? JSON.parse(existingSvg.dataset.points || '[]') : [];
  existingPoints.push([event.recordedAt, event.cost]);

  const rangeMs = Number(container.dataset.rangeMs);
  const rangeEndMs = Date.now();
  const rangeStartMs = rangeEndMs - rangeMs;
  const visiblePoints = existingPoints.filter(([t]) => t >= rangeStartMs);

  container.innerHTML = buildPriceHistoryChartMarkup(visiblePoints, rangeStartMs, rangeEndMs);
  const newSvg = container.querySelector('.price-history-chart');
  if (newSvg) wireChartInteractivity(newSvg);

  const demandEl = document.getElementById(`demand-${event.rewardId}`);
  if (demandEl) demandEl.textContent = `${(event.demand * 100).toFixed(1)}%`;
  const priceEl = document.getElementById(`price-${event.rewardId}`);
  if (priceEl) priceEl.textContent = event.cost.toLocaleString();
}

/** Opens the `/channel-points/events` SSE connection and applies each pushed update, when the page has at least one live chart. */
function initLivePricingUpdates() {
  if (document.querySelectorAll('.price-history-container').length === 0) return;
  const source = new EventSource('/channel-points/events');
  source.onmessage = (event) => {
    try {
      applyLivePricingUpdate(JSON.parse(event.data));
    } catch {
      // Malformed/comment-only SSE frames (e.g. keepalive pings) are expected — ignore.
    }
  };
}

document.addEventListener('DOMContentLoaded', () => {
  initPriceHistoryCharts();
  initLivePricingUpdates();
});
