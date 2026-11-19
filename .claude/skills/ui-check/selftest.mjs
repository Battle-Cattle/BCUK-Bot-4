// ui-check's own tests: fixture `extends`/`status` handling, the variant fixtures rendering their
// state, and the focus and contrast audits catching deliberately broken markup. Not part of
// `npm test` (Playwright isn't a project dependency); run after changing anything in this folder:
//
//   node --test .claude/skills/ui-check/selftest.mjs

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditContrast, auditFocus } from './a11y.mjs';
import { deepMerge, loadFixture } from './fixture.mjs';
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

  it('renders each dashboard variant in its intended state', async () => {
    assert.equal((await renderTexts('dashboard.json', ['#discord-state']))['#discord-state'], 'Connected');
    assert.equal((await renderTexts('dashboard-discord-down.json', ['#discord-state']))['#discord-state'], 'Disconnected');
    assert.equal((await renderTexts('dashboard-voice-playing.json', ['#voice-state']))['#voice-state'], 'Playing');
    const unavailable = await renderTexts('dashboard-feed-unavailable.json', ['#health-indicator', '#status-stale-note']);
    assert.match(unavailable['#health-indicator'], /unknown/i);
    assert.match(unavailable['#status-stale-note'], /not live/);
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
        <div style="background:#fff"><p id="translucent" style="background:rgba(0,0,0,0.1);color:#999">blended</p></div>
        <p id="faded" style="color:#eee;opacity:0.3">faded by opacity</p>
        <p id="gradient" style="background:linear-gradient(#000,#fff);color:#888">over a gradient</p>
        <p id="hidden" style="position:absolute;width:1px;height:1px;overflow:hidden;color:#222">screen reader only</p>
        <button disabled style="color:#333">disabled</button>
      </body></html>`);
      const contrast = await auditContrast(page);
      const failing = contrast.failures.map((f) => f.element).sort();
      assert.deepEqual(failing, ['p#faded', 'p#grey', 'p#translucent']);
      assert.deepEqual(contrast.unverifiable.map((f) => f.element), ['p#gradient']);
      const focus = await auditFocus(page);
      assert.equal(focus.truncated, false);
      assert.equal(focus.visited, 3);
      assert.deepEqual(focus.missingIndicator.map((m) => m.element), ['a#bad-link']);
    } finally {
      await page.close();
    }
  });
});
