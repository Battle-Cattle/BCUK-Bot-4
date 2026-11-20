// ui-check's own tests: fixture `extends`/`status` handling, the variant fixtures rendering their
// state, and the focus and contrast audits catching deliberately broken markup. Not part of
// `npm test` (Playwright isn't a project dependency); the precommit script runs them when this
// folder changes, or run them directly:
//
//   node --test .claude/skills/ui-check/selftest.mjs

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditContrast, auditFocus, contrastRatio, effectiveColours, hasFocusIndicator, requiredRatio } from './a11y.mjs';
import { deepMerge, loadFixture } from './fixture.mjs';
import { findClippedContent } from './layout.mjs';
import { renderPage, settle, startServer } from './render.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const STATUS_API = '/api/status';
const STATUS_SSE = '/dashboard/status/events';

/**
 * Every status payload a loaded dashboard fixture serves: initial render, fetch stub and each stream event.
 * @param fixture - A loaded fixture.
 * @returns The payloads, in that order.
 */
function statusPayloads(fixture) {
  return [fixture.locals.status, fixture.api[STATUS_API], ...fixture.sse[STATUS_SSE].map((e) => e.data)];
}

describe('fixture loading', () => {
  it('deep-merges objects, replaces arrays and scalars, keeps null and removes "$remove" keys', () => {
    const merged = deepMerge(
      { a: { b: 1, c: 2 }, list: [1, 2], keep: 'x', gone: { deep: true } },
      { a: { c: 3 }, list: [9], keep: null, gone: '$remove', added: { d: 4 } },
    );
    assert.deepEqual(merged, { a: { b: 1, c: 3 }, list: [9], keep: null, added: { d: 4 } });
  });

  it('applies the base status to the initial render, the fetch stub and every stream event', async () => {
    const base = await loadFixture(path.join(FIXTURES, 'dashboard.json'));
    for (const payload of statusPayloads(base)) assert.equal(payload.discord.ready, true);
    assert.equal(base.locals.status.voice.currentFile, null, 'real nulls in the status survive');
    assert.ok(base.sse['/dashboard/events'], 'other streams are kept');
  });

  it('applies a variant\'s status on every update path and leaves the rest of the base alone', async () => {
    const base = await loadFixture(path.join(FIXTURES, 'dashboard.json'));
    const down = await loadFixture(path.join(FIXTURES, 'dashboard-discord-down.json'));
    for (const payload of statusPayloads(down)) {
      assert.equal(payload.discord.ready, false);
      assert.deepEqual(payload.voice, base.locals.status.voice);
    }
    const connected = await loadFixture(path.join(FIXTURES, 'dashboard-all-connected.json'));
    for (const payload of statusPayloads(connected)) {
      assert.ok(Object.values(payload.twitch).every((c) => c.connected));
      assert.equal(payload.twitch.streamer_one.isLive, true, 'unchanged channel fields are inherited');
    }
    assert.deepEqual(down.locals.usageStats, base.locals.usageStats);
  });

  it('drops the status stubs for the feed-unavailable variant but keeps the initial render', async () => {
    const fixture = await loadFixture(path.join(FIXTURES, 'dashboard-feed-unavailable.json'));
    assert.equal(fixture.api[STATUS_API], undefined);
    assert.equal(fixture.sse[STATUS_SSE], undefined);
    assert.equal(fixture.locals.status.discord.ready, true);
    assert.ok(fixture.clock.advanceMs > 180000);
  });

  it('refuses an extends cycle', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ui-check-'));
    try {
      await writeFile(path.join(dir, 'a.json'), JSON.stringify({ extends: 'b.json', view: 'dashboard' }));
      await writeFile(path.join(dir, 'b.json'), JSON.stringify({ extends: 'a.json' }));
      await assert.rejects(loadFixture(path.join(dir, 'a.json')), /extends cycle/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe('audit maths', () => {
  const black = { r: 0, g: 0, b: 0, a: 1 };
  const white = { r: 255, g: 255, b: 255, a: 1 };

  it('computes WCAG ratios and the large-text threshold', () => {
    assert.equal(contrastRatio(black, white), 21);
    assert.equal(contrastRatio(white, white), 1);
    assert.equal(requiredRatio(16, 400), 4.5);
    assert.equal(requiredRatio(24, 400), 3);
    assert.equal(requiredRatio(18.66, 700), 3);
    assert.equal(requiredRatio(18.66, 400), 4.5);
  });

  it('blends translucent layers down to the first opaque one and fades text by opacity', () => {
    const rgba = new Map([['fg', white], ['clear', { ...black, a: 0 }], ['half', { ...black, a: 0.5 }], ['black', black], ['white', white]]);
    const layers = [{ background: 'half', image: false, opacity: 0.5 }, { background: 'white', image: false, opacity: 1 }, { background: 'black', image: true, opacity: 1 }];
    const { fg, bg, image } = effectiveColours({ color: 'fg', layers }, rgba);
    assert.equal(Math.round(bg.r), 128, 'half black over white');
    assert.equal(Math.round(fg.r), 191, 'white text at 50% opacity over that');
    assert.equal(image, false, 'an image below the first opaque layer is hidden by it');
    assert.equal(effectiveColours({ color: 'fg', layers: [{ background: 'clear', image: false, opacity: 1 }] }, rgba).bg.r, 255, 'unpainted root is white');
  });

  it('accepts an outline or a box-shadow ring and rejects transparent or zero-width ones', () => {
    const none = { outlineStyle: 'none', outlineWidth: '0px', outlineColor: 'rgb(0, 0, 0)', boxShadow: 'none' };
    assert.equal(hasFocusIndicator(none), false);
    assert.equal(hasFocusIndicator({ ...none, outlineStyle: 'solid', outlineWidth: '2px' }), true);
    assert.equal(hasFocusIndicator({ ...none, outlineStyle: 'solid', outlineWidth: '2px', outlineColor: 'rgba(0, 0, 0, 0)' }), false);
    assert.equal(hasFocusIndicator({ ...none, boxShadow: 'rgb(153, 204, 255) 0px 0px 0px 3px' }), true);
    assert.equal(hasFocusIndicator({ ...none, boxShadow: 'rgba(0, 0, 0, 0) 0px 0px 0px 3px' }), false);
  });
});

/**
 * Measures the System Status panel's Twitch list in the page (runs in the browser).
 * @returns How many channel rows sit fully inside the list, its height and widths, how many badges poke out of the
 *   panel's right edge, and the bottoms of the Usage section and the sidebar.
 */
function measureTwitchList() {
  const doc = globalThis.document;
  const rect = (el) => el.getBoundingClientRect();
  const list = doc.getElementById('twitch-channels');
  const listBox = rect(list);
  const rows = [...list.querySelectorAll('.channel-item')];
  const panel = rect(doc.querySelector('.system-status'));
  const badges = [...list.querySelectorAll('.badge')];
  return {
    visible: rows.filter((r) => rect(r).top >= listBox.top - 1 && rect(r).bottom <= listBox.bottom + 1).length,
    listHeight: Math.round(listBox.height),
    scrollWidth: list.scrollWidth,
    clientWidth: list.clientWidth,
    badgesOutside: badges.filter((b) => rect(b).right > panel.right + 1).length,
    usageBottom: rect(doc.querySelector('.dashboard-usage')).bottom,
    sidebarBottom: rect(doc.querySelector('.dashboard-sidebar')).bottom,
    pageOver: doc.documentElement.scrollHeight - doc.documentElement.clientHeight,
  };
}

describe('in the browser', () => {
  let browser;
  before(async () => { browser = await chromium.launch(); });
  after(async () => { await browser.close(); });

  /**
   * Renders a fixture through the ui-check server and returns some element texts once it has settled.
   * @param name - Fixture file name in fixtures/.
   * @param selectors - CSS selectors whose text to read.
   * @returns The trimmed text of each selector, keyed by selector.
   */
  async function renderTexts(name, selectors) {
    const fixture = await loadFixture(path.join(FIXTURES, name));
    const { server, baseUrl } = await startServer(await renderPage(fixture), fixture);
    const page = await browser.newPage();
    try {
      if (fixture.clock) await page.clock.install();
      await page.goto(baseUrl);
      await settle(page, fixture);
      const texts = {};
      for (const s of selectors) texts[s] = (await page.locator(s).innerText()).trim();
      return texts;
    } finally {
      await page.close();
      server.closeAllConnections();
      server.close();
    }
  }

  it('finds no focus or contrast failures on the base dashboard', async () => {
    const fixture = await loadFixture(path.join(FIXTURES, 'dashboard.json'));
    const { server, baseUrl } = await startServer(await renderPage(fixture), fixture);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(baseUrl);
      await settle(page, fixture);
      const contrast = await auditContrast(page);
      assert.ok(contrast.checked > 50);
      assert.deepEqual(contrast.failures, []);
      const focus = await auditFocus(page);
      assert.ok(focus.visited > 10);
      assert.deepEqual(focus.missingIndicator, []);
    } finally {
      await page.close();
      server.closeAllConnections();
      server.close();
    }
  });

  it('keeps the widest nav inside the viewport at every width, collapsing it at and below --nav-collapse-max', async () => {
    const fixture = await loadFixture(path.join(FIXTURES, 'dashboard-owner-long-names.json'));
    const { server, baseUrl } = await startServer(await renderPage(fixture), fixture);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(baseUrl);
      await settle(page, fixture);
      const collapseMax = parseInt(await page.evaluate(() => globalThis.getComputedStyle(globalThis.document.documentElement).getPropertyValue('--nav-collapse-max')), 10);
      assert.ok(collapseMax > 640, `--nav-collapse-max is declared (${collapseMax})`);
      for (const width of [641, 700, 768, 820, 1024, 1100, collapseMax, collapseMax + 1, 1250, 1300, 1440, 1700]) {
        await page.setViewportSize({ width, height: 900 });
        assert.deepEqual(await findClippedContent(page), [], `nothing is clipped at ${width}px`);
        const toggleShown = await page.locator('.navbar-toggle').isVisible();
        assert.equal(toggleShown, width <= collapseMax, `the toggle is ${toggleShown ? '' : 'not '}shown at ${width}px`);
        // Keyboard reach: Tab through the nav (opening the menu first where it's collapsed). Every stop must sit inside
        // the viewport, and Logout, the last item and the one that used to be clipped away, must be among them. A fresh
        // load per width, because the browser keeps its focus starting point from the previous run.
        await page.reload({ waitUntil: 'load' });
        if (toggleShown) await page.locator('.navbar-toggle').click();
        const stops = [];
        for (let i = 0; i < 40; i++) {
          await page.keyboard.press('Tab');
          const stop = await page.evaluate(() => {
            const el = globalThis.document.activeElement;
            const box = el.getBoundingClientRect();
            return { inNav: !!el.closest('.navbar'), text: (el.textContent || '').trim().slice(0, 20), left: box.left, right: box.right, width: globalThis.document.documentElement.clientWidth };
          });
          if (!stop.inNav) break;
          stops.push(stop);
        }
        assert.ok(stops.some((s) => s.text === 'Logout'), `Tab reaches Logout at ${width}px (got ${stops.map((s) => s.text).join(', ')})`);
        for (const stop of stops) assert.ok(stop.left >= 0 && stop.right <= stop.width, `"${stop.text}" is inside the viewport at ${width}px (${stop.left}-${stop.right} of ${stop.width})`);
      }
    } finally {
      await page.close();
      server.closeAllConnections();
      server.close();
    }
  });

  /**
   * Opens a fixture in a desktop-sized page, runs `fn` with a helper that resizes it and measures the Twitch list,
   * and cleans up.
   * @param name - Fixture file name in fixtures/.
   * @param fn - Receives `at(width, height)`, which resizes the page and returns `measureTwitchList()`.
   */
  async function withTwitchList(name, fn) {
    const fixture = await loadFixture(path.join(FIXTURES, name));
    const { server, baseUrl } = await startServer(await renderPage(fixture), fixture);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(baseUrl);
      await settle(page, fixture);
      await fn(async (width, height) => {
        await page.setViewportSize({ width, height });
        return page.evaluate(measureTwitchList);
      });
    } finally {
      await page.close();
      server.closeAllConnections();
      server.close();
    }
  }

  it('shows several Twitch channels in the System Status panel, and more when the status row has spare height (#1076)', async () => {
    await withTwitchList('dashboard-six-channels.json', async (at) => {
      const base = await at(1440, 900);
      assert.ok(base.visible >= 4, `at least 4 of the 6 channels show at 1440x900 (${base.visible})`);
      // With the short 3-event feed the main column sets the page height, so there is no spare height to grow into.
      assert.ok(Math.abs((await at(1440, 1200)).listHeight - base.listHeight) <= 1, 'the list stays compact when nothing is spare');
    });
    await withTwitchList('dashboard-fourteen-channels-busy-feed.json', async (at) => {
      const base = await at(1440, 900);
      let previous = base.visible;
      for (const height of [900, 1000, 1080, 1200]) {
        const m = await at(1440, height);
        assert.ok(m.pageOver <= 0, `no page scrollbar at 1440x${height} (${m.pageOver}px over)`);
        assert.ok(m.visible >= previous, `the visible count never drops as the viewport grows (${m.visible} at ${height})`);
        assert.ok(m.usageBottom <= m.sidebarBottom, `Usage doesn't extend past the sidebar at ${height} (${m.usageBottom} > ${m.sidebarBottom})`);
        previous = m.visible;
      }
      assert.ok(previous >= base.visible + 3, `the list gains at least 3 rows by 1200px high (${base.visible} to ${previous})`);
    });
  });

  it('keeps the Twitch list and its badges inside the panel at every width (#1076)', async () => {
    await withTwitchList('dashboard-six-channels.json', async (at) => {
      for (const width of [390, 768, 820, 1101, 1250, 1440, 1700]) {
        const m = await at(width, 900);
        assert.ok(m.scrollWidth <= m.clientWidth + 1, `the list doesn't scroll sideways at ${width}px (${m.scrollWidth} > ${m.clientWidth})`);
        assert.equal(m.badgesOutside, 0, `no badge pokes out of the panel at ${width}px`);
      }
    });
  });

  it('keeps a busy event feed from giving the desktop dashboard a page scrollbar (#1130)', async () => {
    const fixture = await loadFixture(path.join(FIXTURES, 'dashboard-busy-feed.json'));
    const { server, baseUrl } = await startServer(await renderPage(fixture), fixture);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(baseUrl);
      await settle(page, fixture);
      assert.ok((await page.locator('#recent-events-list > *').count()) >= 20, 'the fixture fills the feed');
      // The feed is the tallest column here, so the page only fits when its cap leaves room for everything around it,
      // the health indicator included. Below ~900px the main column (status cards, links, usage) is itself taller
      // than the viewport, so the page scrolls by design whatever the feed does: sweep the heights above that.
      for (const height of [900, 1000, 1080, 1200]) {
        await page.setViewportSize({ width: 1440, height });
        const over = await page.evaluate(() => globalThis.document.documentElement.scrollHeight - globalThis.document.documentElement.clientHeight);
        assert.ok(over <= 0, `no page scrollbar at 1440x${height} (page is ${over}px taller than the viewport)`);
      }
      // At 768px high the page scrolls by design, but the feed must not be the reason: it scrolls inside itself, ends
      // above the bottom of the layout (the main column sets that), and the sticky sidebar still clears the navbar
      // once scrolled to the end.
      for (const height of [768, 900]) {
        await page.setViewportSize({ width: 1440, height });
        await page.evaluate(() => globalThis.scrollTo(0, globalThis.document.documentElement.scrollHeight));
        const m = await page.evaluate(() => {
          const rect = (sel) => globalThis.document.querySelector(sel).getBoundingClientRect();
          const feed = globalThis.document.querySelector('.dashboard-events-body');
          return { scrolls: feed.scrollHeight > feed.clientHeight, feedBottom: rect('.dashboard-events-body').bottom, usageBottom: rect('.dashboard-usage').bottom, sidebarTop: rect('.dashboard-sidebar').top, navBottom: rect('.navbar').bottom };
        });
        assert.ok(m.scrolls, `the feed scrolls inside itself at 1440x${height}`);
        if (height === 768) assert.ok(m.feedBottom <= m.usageBottom, `the feed doesn't set the page height at 1440x${height} (feed ends ${m.feedBottom}, main column ${m.usageBottom})`);
        assert.ok(m.sidebarTop >= m.navBottom, `the sidebar stays below the navbar at the end of the scroll at 1440x${height} (${m.sidebarTop} vs ${m.navBottom})`);
      }
    } finally {
      await page.close();
      server.closeAllConnections();
      server.close();
    }
  });

  it('renders each dashboard variant in its intended state', async () => {
    assert.equal((await renderTexts('dashboard.json', ['#discord-state']))['#discord-state'], 'Connected');
    assert.equal((await renderTexts('dashboard-discord-down.json', ['#discord-state']))['#discord-state'], 'Disconnected');
    assert.equal((await renderTexts('dashboard-voice-playing.json', ['#voice-state']))['#voice-state'], 'Playing');
    const channels = (await renderTexts('dashboard-all-connected.json', ['#twitch-channels']))['#twitch-channels'];
    assert.equal(channels.match(/\bConnected\b/g)?.length, 4, 'all four channels show Connected');
    assert.doesNotMatch(channels, /Disconnected|Never connected/i);
    const unavailable = await renderTexts('dashboard-feed-unavailable.json', ['#health-indicator', '#status-stale-note', '#twitch-state']);
    assert.match(unavailable['#health-indicator'], /unknown/i);
    assert.match(unavailable['#status-stale-note'], /not live/);
    assert.equal(unavailable['#twitch-state'], 'Unknown');
    // The Twitch card's roll-up (#1074): some, all and no channels connected, and none configured.
    assert.equal((await renderTexts('dashboard.json', ['#twitch-state']))['#twitch-state'], 'Degraded (2 of 4)');
    assert.equal((await renderTexts('dashboard-all-connected.json', ['#twitch-state']))['#twitch-state'], 'Connected');
    const none = await renderTexts('dashboard-no-channels.json', ['#twitch-state', '#twitch-channels']);
    assert.equal(none['#twitch-state'], 'No channels configured');
    assert.equal(none['#twitch-channels'], 'No Twitch channels configured.');
  });

  it('reports a link with outline: none and grey-on-grey text, and passes the good cases', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<!doctype html><html><body style="background:#202020;color:#eee;margin:0">
        <a id="bad-link" href="#a" style="outline:none">no ring</a>
        <a id="good-link" href="#b" class="ok">ring</a>
        <button id="shadow-button" class="shadow">shadow ring</button>
        <style>a{color:#9cf}.ok:focus-visible{outline:2px solid #fff}.shadow:focus-visible{outline:none;box-shadow:0 0 0 3px #9cf}</style>
        <p id="grey" style="color:#555">grey on grey</p>
        <p id="large" style="color:#777;font-size:24px">large text passes at 3:1</p>
        <p id="large-bold" style="color:#777;font-size:18.66px;font-weight:700">bold large text passes at 3:1</p>
        <p id="small-bold" style="color:#777;font-size:18px;font-weight:700">smaller bold text needs 4.5:1</p>
        <div style="background:#fff"><p id="translucent" style="background:rgba(0,0,0,0.1);color:#999">blended</p></div>
        <p id="faded" style="color:#eee;opacity:0.3">faded by opacity</p>
        <p id="gradient" style="background:linear-gradient(#000,#fff);color:#888">over a gradient</p>
        <p id="hidden" style="position:absolute;width:1px;height:1px;overflow:hidden;color:#222">screen reader only</p>
        <button disabled style="color:#333">disabled</button>
      </body></html>`);
      const contrast = await auditContrast(page);
      const failing = contrast.failures.map((f) => f.element).sort();
      assert.deepEqual(failing, ['p#faded', 'p#grey', 'p#small-bold', 'p#translucent']);
      assert.deepEqual(contrast.unverifiable.map((f) => f.element), ['p#gradient']);
      const focus = await auditFocus(page);
      assert.equal(focus.truncated, false);
      assert.equal(focus.visited, 3);
      assert.deepEqual(focus.missingIndicator.map((m) => m.element), ['a#bad-link']);
    } finally {
      await page.close();
    }
  });

  it('opens a closed nav toggle before tabbing, so the links it hides are visited', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<!doctype html><html><body>
        <button class="navbar-toggle" aria-expanded="false">menu</button>
        <nav id="menu" hidden><a href="#1">one</a><a href="#2">two</a></nav>
        <script>
          const t = document.querySelector('.navbar-toggle');
          t.addEventListener('click', () => { t.setAttribute('aria-expanded', 'true'); document.getElementById('menu').hidden = false; });
        </script>
      </body></html>`);
      const focus = await auditFocus(page);
      assert.equal(focus.visited, 3);
    } finally {
      await page.close();
    }
  });

  it('reports content clipped at the viewport edge, but not content inside its own scroller', async () => {
    const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
    try {
      await page.setContent(`<!doctype html><html style="overflow-x:clip"><body style="overflow-x:clip;margin:0">
        <div style="display:flex;width:600px"><span style="flex:0 0 380px">fits</span><button id="off">Logout</button></div>
        <div style="overflow-x:auto"><p style="width:900px">scrolls inside its own box</p></div>
      </body></html>`);
      const clipped = await findClippedContent(page);
      assert.equal(clipped.length, 1);
      assert.match(clipped[0], /^button#off "Logout"/);
      await page.setContent('<!doctype html><html><body><p>all inside</p></body></html>');
      assert.deepEqual(await findClippedContent(page), []);
    } finally {
      await page.close();
    }
  });
});
