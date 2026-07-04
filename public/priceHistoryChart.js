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

/** Wires up hover/focus crosshair+tooltip behavior for every `.price-history-chart` on the page. */
function initPriceHistoryCharts() {
  const charts = document.querySelectorAll('.price-history-chart');
  if (charts.length === 0) return;

  const tooltip = document.createElement('div');
  tooltip.className = 'price-history-tooltip';
  tooltip.style.display = 'none';
  document.body.appendChild(tooltip);

  charts.forEach((svg) => {
    svg.addEventListener('pointermove', (event) => updateCrosshair(svg, tooltip, event.clientX));
    svg.addEventListener('pointerleave', () => updateCrosshair(svg, tooltip, null));
  });
}

document.addEventListener('DOMContentLoaded', initPriceHistoryCharts);
