// ui-check accessibility audits: visible keyboard focus and WCAG AA text contrast. See "What to check"
// in SKILL.md for what each one reports and its limits.
//
// The functions passed to page.evaluate run in the browser, so they must be self-contained (no
// closures over this module) and reach `document`/`window` through globalThis for the Node linter.

/** Tab presses before giving up on the focus order cycling back (a page with more stops is reported as truncated). */
const MAX_TAB_STOPS = 250;

/** Selector for a mobile nav toggle that hides links until opened (views/partials/nav.ejs). */
const NAV_TOGGLE = '.navbar-toggle[aria-expanded="false"]';

/**
 * Describes the focused element and whether it draws a focus indicator. Runs in the page.
 * @returns `null` when nothing (or the body) has focus, otherwise the element's selector, label and focus styles.
 */
function describeActiveElement() {
  const doc = globalThis.document;
  const el = doc.activeElement;
  if (!el || el === doc.body || el === doc.documentElement) return null;
  globalThis.__uiCheckFocusSeen ??= [];
  const index = globalThis.__uiCheckFocusSeen.indexOf(el);
  if (index === -1) globalThis.__uiCheckFocusSeen.push(el);
  const style = globalThis.getComputedStyle(el);
  const outlineWidth = Number.parseFloat(style.outlineWidth) || 0;
  const transparent = (c) => c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);
  const outline = style.outlineStyle !== 'none' && outlineWidth > 0 && !transparent(style.outlineColor);
  const shadow = style.boxShadow !== 'none' && !/^rgba\([^)]*,\s*0\)/.test(style.boxShadow);
  const name = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${[...el.classList].map((c) => `.${c}`).join('')}`;
  const label = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  return {
    repeat: index !== -1,
    element: name,
    label,
    outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
    boxShadow: style.boxShadow,
    visible: outline || shadow,
  };
}

/**
 * Tabs through the page from the top until focus cycles back to an element already visited, and
 * records each stop's focus indicator. On a narrow layout, opens the nav toggle first so its links
 * are reachable, as a keyboard user would.
 * @param page - The Playwright page, already loaded and settled.
 * @returns `{ visited, missingIndicator, truncated }`: the number of distinct stops, the ones with no
 *   visible outline or box-shadow ring, and whether MAX_TAB_STOPS ran out before focus cycled.
 */
export async function auditFocus(page) {
  const toggle = page.locator(NAV_TOGGLE);
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
  await page.evaluate(() => {
    globalThis.__uiCheckFocusSeen = [];
    globalThis.document.activeElement?.blur();
    globalThis.scrollTo(0, 0);
  });
  const stops = [];
  let truncated = true;
  for (let i = 0; i < MAX_TAB_STOPS; i++) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(describeActiveElement);
    if (stop?.repeat) { truncated = false; break; }
    if (stop) stops.push(stop);
  }
  return {
    visited: stops.length,
    missingIndicator: stops.filter((s) => !s.visible).map(({ element, label, outline, boxShadow }) => ({ element, label, outline, boxShadow })),
    truncated,
  };
}

/**
 * Measures the WCAG contrast of every visible element with direct text against its effective
 * background. Runs in the page.
 * @returns `{ checked, failures, unverifiable }`: elements measured, those under AA, and those whose
 *   background is an image or gradient (so a solid-colour ratio can't be trusted).
 */
function measureContrast() {
  const doc = globalThis.document;
  const ctx = doc.createElement('canvas').getContext('2d', { willReadFrequently: true });
  // Any CSS colour (rgb, oklch, color-mix, …) to sRGB 0-255 plus alpha 0-1, via a 1px canvas.
  const toRgba = (css) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return { r, g, b, a: a / 255 };
  };
  const over = (top, under) => ({
    r: top.r * top.a + under.r * (1 - top.a),
    g: top.g * top.a + under.g * (1 - top.a),
    b: top.b * top.a + under.b * (1 - top.a),
    a: 1,
  });
  const luminance = ({ r, g, b }) => {
    const lin = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const hex = ({ r, g, b }) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  const describe = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${[...el.classList].map((c) => `.${c}`).join('')}`;

  // Background layers from the element up to the first opaque one, then blended bottom-up.
  const background = (el) => {
    const layers = [];
    let image = false;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const style = globalThis.getComputedStyle(node);
      if (style.backgroundImage !== 'none') image = true;
      const colour = toRgba(style.backgroundColor);
      if (colour.a > 0) layers.push(colour);
      if (colour.a >= 1) break;
    }
    // The canvas behind an unpainted root is white.
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    for (const layer of layers.reverse()) bg = over(layer, bg);
    return { bg, image };
  };
  const opacity = (el) => {
    let value = 1;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) value *= Number(globalThis.getComputedStyle(node).opacity);
    return value;
  };

  const failures = [];
  const unverifiable = [];
  let checked = 0;
  const seen = new Set();
  for (const el of doc.body.querySelectorAll('*')) {
    const text = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim().replace(/\s+/g, ' ');
    if (!text || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'OPTION'].includes(el.tagName)) continue;
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const rect = el.getBoundingClientRect();
    // Visually hidden (sr-only) text and disabled controls are exempt from the contrast criterion.
    if (rect.width <= 1 || rect.height <= 1 || el.closest(':disabled')) continue;
    const style = globalThis.getComputedStyle(el);
    const { bg, image } = background(el);
    const fgRaw = toRgba(style.color);
    const fg = over({ ...fgRaw, a: fgRaw.a * opacity(el) }, bg);
    const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
    const ratio = Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
    const size = Number.parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
    const required = large ? 3 : 4.5;
    checked++;
    const entry = { element: describe(el), text: text.slice(0, 40), ratio, required, color: hex(fg), background: hex(bg) };
    const key = `${entry.element}|${entry.color}|${entry.background}`;
    if (image) { if (!seen.has(key)) unverifiable.push(entry); seen.add(key); continue; }
    if (ratio < required && !seen.has(key)) { failures.push(entry); seen.add(key); }
  }
  return { checked, failures, unverifiable };
}

/**
 * Runs the contrast audit on the page as it is now.
 * @param page - The Playwright page, already loaded and settled.
 * @returns The contrast findings (see measureContrast).
 */
export function auditContrast(page) {
  return page.evaluate(measureContrast);
}

/**
 * Sums the audits across runs into one line for the console.
 * @param results - Each run's findings, some with `a11y.focus` and `a11y.contrast`.
 * @returns A one-line summary such as "a11y: 0 focus stops without an indicator, 2 contrast failures (report-only)".
 */
export function summariseA11y(results) {
  let focus = 0;
  let contrast = 0;
  let unverifiable = 0;
  for (const { a11y } of results) {
    focus += a11y?.focus?.missingIndicator.length ?? 0;
    contrast += a11y?.contrast?.failures.length ?? 0;
    unverifiable += a11y?.contrast?.unverifiable.length ?? 0;
  }
  return `a11y: ${focus} focus stop(s) without a visible indicator, ${contrast} contrast failure(s), ` +
    `${unverifiable} text element(s) over an image or gradient to check by eye (report-only; see report.json)`;
}
