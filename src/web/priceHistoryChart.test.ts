import { describe, it, expect } from 'vitest';
import { renderPriceHistoryChart } from './priceHistoryChart';

describe('renderPriceHistoryChart', () => {
  it('renders a placeholder when there are no points', () => {
    const svg = renderPriceHistoryChart([], 1_700_000_000_000, 1_700_010_000_000);
    expect(svg).toContain('No price history yet');
    expect(svg).not.toContain('<svg');
  });

  it('renders an svg with a polyline through the given points', () => {
    const points = [
      { t: 1_700_000_000_000, cost: 200 },
      { t: 1_700_005_000_000, cost: 500 },
      { t: 1_700_010_000_000, cost: 350 },
    ];
    const svg = renderPriceHistoryChart(points, 1_700_000_000_000, 1_700_010_000_000);
    expect(svg).toContain('<svg');
    expect(svg).toContain('<polyline');
    expect(svg).toMatch(/points="[\d.]+,[\d.]+ [\d.]+,[\d.]+ [\d.]+,[\d.]+"/);
  });

  it('sorts unsorted input points by time before plotting', () => {
    const points = [
      { t: 1_700_010_000_000, cost: 350 },
      { t: 1_700_000_000_000, cost: 200 },
    ];
    const svg = renderPriceHistoryChart(points, 1_700_000_000_000, 1_700_010_000_000);
    const dataPoints = svg.match(/data-points='(.*?)'/)?.[1];
    expect(dataPoints).toBeDefined();
    const parsed = JSON.parse(dataPoints!.replace(/&#39;/g, "'"));
    expect(parsed[0][0]).toBe(1_700_000_000_000);
    expect(parsed[1][0]).toBe(1_700_010_000_000);
  });

  it('labels the min and max cost ticks', () => {
    const points = [
      { t: 1_700_000_000_000, cost: 200 },
      { t: 1_700_010_000_000, cost: 800 },
    ];
    const svg = renderPriceHistoryChart(points, 1_700_000_000_000, 1_700_010_000_000);
    expect(svg).toContain('>200<');
    expect(svg).toContain('>800<');
  });

  it('labels the end point with its cost', () => {
    const points = [{ t: 1_700_000_000_000, cost: 480 }];
    const svg = renderPriceHistoryChart(points, 1_700_000_000_000, 1_700_010_000_000);
    expect(svg).toContain('480 pts');
  });

  it('centers the line vertically instead of collapsing to the bottom edge when all costs are equal (flat range)', () => {
    const points = [
      { t: 1_700_000_000_000, cost: 300 },
      { t: 1_700_010_000_000, cost: 300 },
    ];
    const svg = renderPriceHistoryChart(points, 1_700_000_000_000, 1_700_010_000_000);
    expect(svg).not.toContain('NaN');
    // HEIGHT=120, PADDING.top=10, PADDING.bottom=20 -> plotTop=10, plotBottom=100, centered=55.0
    expect(svg).toMatch(/points="[\d.]+,55\.0 [\d.]+,55\.0"/);
  });

  it('embeds the plotted time range as data attributes', () => {
    const points = [{ t: 1_700_000_000_000, cost: 480 }];
    const svg = renderPriceHistoryChart(points, 1_700_000_000_000, 1_700_010_000_000);
    expect(svg).toContain('data-range-start="1700000000000"');
    expect(svg).toContain('data-range-end="1700010000000"');
  });

  it('disables aspect-ratio preservation so the viewBox stretches to fill its actual rendered size', () => {
    // Without this, the browser letterboxes the chart whenever its rendered box doesn't
    // match the 480:120 viewBox ratio (the common case — the card is much wider), which
    // throws off priceHistoryChart.js's pointer-to-chart-coordinate hover math.
    const points = [{ t: 1_700_000_000_000, cost: 480 }];
    const svg = renderPriceHistoryChart(points, 1_700_000_000_000, 1_700_010_000_000);
    expect(svg).toContain('preserveAspectRatio="none"');
  });

  it('uses the default date-based aria-label when no override is given', () => {
    const points = [{ t: 1_700_000_000_000, cost: 480 }];
    const svg = renderPriceHistoryChart(points, 1_700_000_000_000, 1_700_010_000_000);
    expect(svg).toContain('aria-label="Price history from');
  });

  it('uses a custom aria-label when one is provided via options', () => {
    const points = [{ t: 0, cost: 480 }];
    const svg = renderPriceHistoryChart(points, 0, 1000, { ariaLabel: 'Simulated demand cycle' });
    expect(svg).toContain('aria-label="Simulated demand cycle"');
    expect(svg).not.toContain('Price history from');
  });

  it('escapes double quotes and ampersands in a custom aria-label', () => {
    const points = [{ t: 0, cost: 480 }];
    const svg = renderPriceHistoryChart(points, 0, 1000, { ariaLabel: 'Peak "demand" & price' });
    expect(svg).toContain('aria-label="Peak &quot;demand&quot; &amp; price"');
  });

  it('marks the chart as an elapsed-time axis when requested', () => {
    const points = [{ t: 0, cost: 480 }];
    const svg = renderPriceHistoryChart(points, 0, 1000, { elapsedTimeAxis: true });
    expect(svg).toContain('data-elapsed="true"');
  });

  it('omits the data-elapsed attribute by default', () => {
    const points = [{ t: 1_700_000_000_000, cost: 480 }];
    const svg = renderPriceHistoryChart(points, 1_700_000_000_000, 1_700_010_000_000);
    expect(svg).not.toContain('data-elapsed');
  });
});
