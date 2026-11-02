import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import ejs from 'ejs';

const viewPath = path.join(__dirname, '../../views/dashboard.ejs');
const stylePath = path.join(__dirname, '../../public/style.css');
const layoutScriptPath = path.join(__dirname, '../../public/dashboard-layout.js');

const USER = { discordId: '1', discordName: 'Streamer', accessLevel: 3, isOwner: false, currentGuildId: '900000000000000001', guilds: [] };

function render(locals: Record<string, unknown> = {}): Promise<string> {
  return ejs.renderFile(viewPath, {
    user: USER,
    status: { voice: { connected: false }, twitch: { streamer: { connected: true } } },
    recentEvents: [],
    hasStreamer: true,
    usageStats: { sfxCount: 1, commandCount: 2, counterCount: 3 },
    csrfToken: 'tok',
    needsReconnect: false,
    ...locals,
  });
}

/** Returns the HTML between the first `open` and the first `close` after it. */
function between(html: string, open: string, close: string): string {
  const start = html.indexOf(open);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = html.indexOf(close, start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

/** Returns the element opened at `open`, through its matching `</div>`. */
function divBlock(html: string, open: string): string {
  const start = html.indexOf(open);
  expect(start).toBeGreaterThanOrEqual(0);
  const tags = /<(\/?)div\b/g;
  tags.lastIndex = start;
  let depth = 0;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, html.indexOf('>', match.index) + 1);
  }
  throw new Error(`no closing </div> for ${open}`);
}

describe('views/dashboard.ejs layout', () => {
  it('puts the recent events feed in the sidebar', async () => {
    const html = await render();

    expect(between(html, '<aside class="dashboard-sidebar"', '</aside>')).toContain('id="recent-events-list"');
    expect(html.match(/id="recent-events-list"/g)).toHaveLength(1);
  });

  it('shows the Twitch channel status as a Bot Status card instead of a separate Channels section', async () => {
    const html = await render();
    const status = between(html, '<section class="section dashboard-status">', '</section>');

    expect(divBlock(status, '<div class="status-grid">')).toContain('id="twitch-channels"');
    expect(html).not.toContain('<h2 class="section-title">Channels</h2>');
  });

  it('puts the sections in source order Bot Status, events sidebar, Quick Links, Usage', async () => {
    const layout = divBlock(await render(), '<div class="dashboard-layout">');

    const positions = [
      '<section class="section dashboard-status">',
      '<aside class="dashboard-sidebar"',
      '<section class="section dashboard-links">',
      '<section class="section dashboard-usage">',
    ].map((tag) => layout.indexOf(tag));
    expect(positions[0]).toBeGreaterThanOrEqual(0);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it.each([
    ['signed out', { user: null }, 'Sign in to see recent activity.'],
    ['without a linked streamer', { hasStreamer: false }, 'Connect your Twitch account to see recent activity.'],
    ['with a streamer and no events', {}, 'No recent activity yet.'],
  ])('shows the right empty feed message %s', async (_case, locals, message) => {
    const html = await render(locals);

    expect(between(html, 'id="recent-events-list"', '</section>')).toContain(message);
  });

  it('collapses the dashboard into one column, events second, at 1100px and below', () => {
    const css = fs.readFileSync(stylePath, 'utf8');
    const narrowRules = /@media \(max-width: 1100px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';

    expect(narrowRules).toMatch(/\.dashboard-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/);
    expect(narrowRules).toMatch(/grid-template-areas:\s*"status" "events" "links" "usage"/);
  });

  it('lets long Twitch channel names wrap inside the status card', () => {
    const css = fs.readFileSync(stylePath, 'utf8');

    // Twitch names run to 25 characters; unwrapped, one pushes the connection badge out of a 210px card.
    expect(css).toMatch(/\.dashboard-layout \.channel-name\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });

  it('gives the event feed and Twitch list the dark scroll styling', async () => {
    const html = await render();

    expect(html).toMatch(/class="[^"]*\bdashboard-scroll\b[^"]*" id="recent-events-list"/);
    expect(html).toMatch(/class="[^"]*\bdashboard-scroll\b[^"]*" id="twitch-channels"/);
    expect(fs.readFileSync(stylePath, 'utf8')).toMatch(/\.dashboard-scroll\s*\{[^}]*scrollbar-color:\s*var\(--border\) transparent/);
  });

  it('makes both scroll areas keyboard-focusable, labelled regions', async () => {
    const html = await render();

    // Safari doesn't focus scroll containers on its own, so without tabindex keyboard users can't scroll them.
    expect(html).toMatch(/id="twitch-channels" tabindex="0" role="region" aria-label="Twitch channels"/);
    expect(html).toMatch(/id="recent-events-list" tabindex="0" role="region" aria-label="Recent events feed"/);
  });

  it('caps the Twitch channel list so a long list scrolls instead of stretching the status row', async () => {
    const html = await render();
    const css = fs.readFileSync(stylePath, 'utf8');

    expect(html).toMatch(/class="[^"]*\bdashboard-twitch-body\b[^"]*" id="twitch-channels"/);
    expect(css).toMatch(/\.dashboard-twitch-body\s*\{[^}]*max-height:\s*10rem;[^}]*overflow-y:\s*auto/);
  });

  it('caps the desktop feed to leave room for the navbar, sidebar chrome and footer', () => {
    const css = fs.readFileSync(stylePath, 'utf8');
    const desktopRules = css.slice(0, css.indexOf('@media (max-width: 1100px)'));
    const cap = /\.dashboard-events-body\s*\{[^}]*max-height:\s*calc\(100vh - var\(--dashboard-nav-offset\) - ([\d.]+)rem\)/.exec(desktopRules);

    // A static guard on the stylesheet, not a rendered check (the suite has no browser). The page around the feed
    // measures ~11.7rem plus the navbar, so a smaller reserve makes the page overflow by a few pixels (a stray page
    // scrollbar) when the feed is the tallest column. If the footer or sidebar chrome grows, re-measure in a
    // browser and raise the reserve and this floor.
    expect(Number(cap?.[1])).toBeGreaterThanOrEqual(11.75);
  });
});

/** Runs public/dashboard-layout.js against a stub DOM with the given navbar and ResizeObserver. */
function runLayoutScript(navbar: { offsetHeight: number } | null, withResizeObserver = true) {
  const setProperty = (name: string, value: string) => { props[name] = value; };
  const props: Record<string, string> = {};
  const observers: { callback: () => void; target: unknown }[] = [];
  class StubResizeObserver {
    constructor(private readonly callback: () => void) {}
    observe(target: unknown) { observers.push({ callback: this.callback, target }); }
  }
  const context: Record<string, unknown> = {
    document: { querySelector: (sel: string) => (sel === '.navbar' ? navbar : null), documentElement: { style: { setProperty } } },
  };
  if (withResizeObserver) context.ResizeObserver = StubResizeObserver;
  vm.runInNewContext(fs.readFileSync(layoutScriptPath, 'utf8'), context);
  return { props, observers };
}

describe('public/dashboard-layout.js', () => {
  it('sets --dashboard-nav-offset to the navbar height and follows it as the navbar resizes', () => {
    const navbar = { offsetHeight: 59 };
    const { props, observers } = runLayoutScript(navbar);
    expect(observers).toHaveLength(1);
    expect(observers[0]!.target).toBe(navbar);

    observers[0]!.callback();
    expect(props['--dashboard-nav-offset']).toBe('59px');

    navbar.offsetHeight = 80;
    observers[0]!.callback();
    expect(props['--dashboard-nav-offset']).toBe('80px');
  });

  it('leaves the CSS fallback in place without a navbar or ResizeObserver', () => {
    expect(runLayoutScript(null)).toEqual({ props: {}, observers: [] });
    expect(runLayoutScript({ offsetHeight: 59 }, false).props).toEqual({});
  });
});
