// ui-check accessibility audits: visible keyboard focus and WCAG AA text contrast. See "What to check"
// in SKILL.md for what each one reports and its limits.
//
// The page only collects raw computed styles (the functions passed to page.evaluate, which must be
// self-contained and reach `document` through globalThis for the Node linter); every judgement and
// all the colour maths happen here in Node, in small functions selftest.mjs checks directly.

/** Tab presses before giving up on the focus order cycling back (a page with more stops is reported as truncated). */
const MAX_TAB_STOPS = 250;

/** Selector for a mobile nav toggle that hides links until opened (views/partials/nav.ejs). */
const NAV_TOGGLE = '.navbar-toggle[aria-expanded="false"]';

/** WCAG AA minimum contrast for normal and for large text. */
const AA_NORMAL = 4.5;
const AA_LARGE = 3;

/** The canvas behind an unpainted root. */
const WHITE = { r: 255, g: 255, b: 255, a: 1 };

/**
 * Reads the focused element's raw focus styles. Runs in the page.
 * @returns `null` when nothing (or the body) has focus, otherwise `{ repeat, element, label, outline*, boxShadow }`.
 */
function readActiveElement() {
  const doc = globalThis.document;
  const el = doc.activeElement;
  if (!el || el === doc.body || el === doc.documentElement) return null;
  const seen = (globalThis.__uiCheckFocusSeen ??= []);
  const repeat = seen.includes(el);
  if (!repeat) seen.push(el);
  const style = globalThis.getComputedStyle(el);
  const classes = [...el.classList].map((c) => `.${c}`).join('');
  return {
    repeat,
    element: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${classes}`,
    label: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40),
    outlineStyle: style.outlineStyle,
    outlineWidth: style.outlineWidth,
    outlineColor: style.outlineColor,
    boxShadow: style.boxShadow,
  };
}

/**
 * Says whether a computed colour string is fully transparent.
 * @param css - A computed colour, e.g. `rgba(0, 0, 0, 0)`.
 * @returns True for `transparent` or a zero alpha.
 */
function isTransparent(css) {
  return css === 'transparent' || /^rgba\([^)]*,\s*0\)/.test(css);
}

/**
 * Decides whether a focused element draws a visible ring: a non-zero, non-transparent outline or a
 * non-transparent box-shadow.
 * @param stop - Raw focus styles from readActiveElement.
 * @returns True when a focus indicator is drawn.
 */
export function hasFocusIndicator(stop) {
  const outline = stop.outlineStyle !== 'none' && Number.parseFloat(stop.outlineWidth) > 0 && !isTransparent(stop.outlineColor);
  const shadow = stop.boxShadow !== 'none' && !isTransparent(stop.boxShadow);
  return outline || shadow;
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
  for (let i = 0; i < MAX_TAB_STOPS && truncated; i++) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(readActiveElement);
    if (stop?.repeat) truncated = false;
    else if (stop) stops.push(stop);
  }
  const missingIndicator = stops.filter((s) => !hasFocusIndicator(s))
    .map((s) => ({ element: s.element, label: s.label, outline: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`, boxShadow: s.boxShadow }));
  return { visited: stops.length, missingIndicator, truncated };
}

/**
 * Collects every visible element with direct text and the raw styles its contrast depends on. Runs
 * in the page. Visually hidden (1px) text and disabled controls are skipped: they're exempt.
 * @returns `{ element, text, color, fontSize, fontWeight, layers }` per element, where `layers` runs
 *   from the element up to the root: `{ background, image, opacity }` each.
 */
function collectTextElements() {
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'OPTION']);
  const directText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim().replace(/\s+/g, ' ');
  const hasText = (el) => !skip.has(el.tagName) && directText(el) !== '' && !el.closest(':disabled');
  const shown = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1 && el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  };
  const measurable = (el) => hasText(el) && shown(el);
  const layers = (el) => {
    const out = [];
    for (let node = el; node; node = node.parentElement) {
      const s = globalThis.getComputedStyle(node);
      out.push({ background: s.backgroundColor, image: s.backgroundImage !== 'none', opacity: Number(s.opacity) });
    }
    return out;
  };
  return [...globalThis.document.body.querySelectorAll('*')].filter(measurable).map((el) => {
    const s = globalThis.getComputedStyle(el);
    return {
      element: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${[...el.classList].map((c) => `.${c}`).join('')}`,
      text: directText(el).slice(0, 40),
      color: s.color,
      fontSize: Number.parseFloat(s.fontSize),
      fontWeight: Number(s.fontWeight),
      layers: layers(el),
    };
  });
}

/**
 * Converts CSS colours (any syntax the page's computed styles use: rgb, oklch, color-mix, …) to
 * sRGB through a 1px canvas. Runs in the page.
 * @param colours - Distinct CSS colour strings.
 * @returns `[css, { r, g, b, a }]` pairs, channels 0-255 and alpha 0-1.
 */
function colourValues(colours) {
  const ctx = globalThis.document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  return colours.map((css) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return [css, { r, g, b, a: a / 255 }];
  });
}

/**
 * Paints one colour over another.
 * @param top - The upper colour, with its alpha.
 * @param under - The opaque colour beneath.
 * @returns The opaque result.
 */
export function blend(top, under) {
  const mix = (c) => top[c] * top.a + under[c] * (1 - top.a);
  return { r: mix('r'), g: mix('g'), b: mix('b'), a: 1 };
}

/**
 * Computes the WCAG contrast ratio of two opaque colours.
 * @param a - One colour.
 * @param b - The other.
 * @returns The ratio, rounded to two decimals (1 to 21).
 */
export function contrastRatio(a, b) {
  const lin = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const lum = ({ r, g, b: blue }) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(blue);
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/**
 * Gives the AA minimum for a text size: 3:1 for large text (≥ 24px, or ≥ 18.66px bold), else 4.5:1.
 * @param fontSize - Computed font size in px.
 * @param fontWeight - Computed numeric font weight.
 * @returns The minimum ratio.
 */
export function requiredRatio(fontSize, fontWeight) {
  return fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700) ? AA_LARGE : AA_NORMAL;
}

/**
 * Works out what an element's text is drawn on and in: background layers from the element up to the
 * first opaque one blended bottom-up over white, and the text colour faded by every layer's opacity.
 * @param item - One collected element (`color`, `layers`).
 * @param rgba - CSS colour string to `{ r, g, b, a }`.
 * @returns `{ fg, bg, image }`: opaque text and background colours, and whether an image or gradient sits behind.
 */
export function effectiveColours(item, rgba) {
  const firstOpaque = item.layers.findIndex((l) => rgba.get(l.background).a >= 1);
  const behind = firstOpaque === -1 ? item.layers : item.layers.slice(0, firstOpaque + 1);
  const bg = behind.map((l) => rgba.get(l.background)).reverse().reduce((under, top) => blend(top, under), WHITE);
  const opacity = item.layers.reduce((product, l) => product * l.opacity, 1);
  const text = rgba.get(item.color);
  return { fg: blend({ ...text, a: text.a * opacity }, bg), bg, image: behind.some((l) => l.image) };
}

/**
 * Formats a colour as `#rrggbb`.
 * @param colour - An opaque colour.
 * @returns The hex string.
 */
function hex({ r, g, b }) {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Judges collected elements against AA, once per element/colour pair.
 * @param items - Collected elements (see collectTextElements).
 * @param rgba - CSS colour string to `{ r, g, b, a }`.
 * @returns `{ checked, failures, unverifiable }`: elements measured, those under AA, and those over an
 *   image or gradient (so a solid-colour ratio can't be trusted).
 */
export function judgeContrast(items, rgba) {
  const failures = [];
  const unverifiable = [];
  const seen = new Set();
  for (const item of items) {
    const { fg, bg, image } = effectiveColours(item, rgba);
    const entry = {
      element: item.element, text: item.text, ratio: contrastRatio(fg, bg),
      required: requiredRatio(item.fontSize, item.fontWeight), color: hex(fg), background: hex(bg),
    };
    const key = `${entry.element}|${entry.color}|${entry.background}`;
    const list = image ? unverifiable : (entry.ratio < entry.required ? failures : null);
    if (list && !seen.has(key)) list.push(entry);
    seen.add(key);
  }
  return { checked: items.length, failures, unverifiable };
}

/**
 * Runs the contrast audit on the page as it is now: collects text elements in the page, converts
 * their colours there, and judges them here.
 * @param page - The Playwright page, already loaded and settled.
 * @returns The contrast findings (see judgeContrast).
 */
export async function auditContrast(page) {
  const items = await page.evaluate(collectTextElements);
  const colours = [...new Set(items.flatMap((i) => [i.color, ...i.layers.map((l) => l.background)]))];
  const rgba = new Map(await page.evaluate(colourValues, colours));
  return judgeContrast(items, rgba);
}

/**
 * Sums the audits across runs into one line for the console.
 * @param results - Each run's findings, some with `a11y.focus` and `a11y.contrast`.
 * @returns A one-line summary such as "a11y: 0 focus stop(s) without a visible indicator, 2 contrast failure(s), …".
 */
export function summariseA11y(results) {
  const total = (pick) => results.reduce((sum, r) => sum + (pick(r.a11y ?? {})?.length ?? 0), 0);
  const focus = total((a) => a.focus?.missingIndicator);
  const contrast = total((a) => a.contrast?.failures);
  const unverifiable = total((a) => a.contrast?.unverifiable);
  return `a11y: ${focus} focus stop(s) without a visible indicator, ${contrast} contrast failure(s), ` +
    `${unverifiable} text element(s) over an image or gradient to check by eye (report-only; see report.json)`;
}
