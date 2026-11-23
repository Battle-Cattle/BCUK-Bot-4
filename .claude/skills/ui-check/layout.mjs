// ui-check layout check: content cut off at the viewport's side edges. The panel's CSS sets
// `overflow-x: clip` on html and body, so the page never scrolls sideways and the document's
// scrollWidth can't show overflow; this looks at where elements actually are instead.

/**
 * Lists visible text and controls that sit partly outside the viewport horizontally, skipping any
 * inside an element that clips or scrolls on its own (a table scroller, a feed): only content cut
 * off by the viewport itself counts. Runs in the page.
 * @returns One `"<element> \"<text>\" left Lpx right Rpx"` string per clipped element.
 */
function readClippedContent() {
  const width = globalThis.document.documentElement.clientWidth;
  const root = new Set([globalThis.document.documentElement, globalThis.document.body]);
  const ownScroller = (el) => {
    for (let node = el.parentElement; node && !root.has(node); node = node.parentElement) {
      if (globalThis.getComputedStyle(node).overflowX !== 'visible') return true;
    }
    return false;
  };
  const hasDirectText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
  const candidate = (el) => (el.matches('a[href], button, input, select, textarea, [tabindex]') || hasDirectText(el))
    && el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  return [...globalThis.document.body.querySelectorAll('*')]
    .filter((el) => candidate(el) && !ownScroller(el))
    .map((el) => ({ el, rect: el.getBoundingClientRect() }))
    .filter(({ rect }) => rect.width > 1 && (rect.right > width + 1 || rect.left < -1))
    .map(({ el, rect }) => {
      const name = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${[...el.classList].map((c) => `.${c}`).join('')}`;
      const text = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 30);
      return `${name} "${text}" left ${Math.round(rect.left)}px right ${Math.round(rect.right)}px`;
    });
}

/**
 * Finds content cut off at the viewport's side edges (see readClippedContent).
 * @param page - The settled Playwright page.
 * @returns The clipped elements, described; empty when nothing is cut off.
 */
export function findClippedContent(page) {
  return page.evaluate(readClippedContent);
}
