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
    ownChannel: null,
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

  it('shows the Twitch channels inside the System Status panel instead of a separate Channels section', async () => {
    const html = await render();
    const status = between(html, '<section class="section dashboard-status" id="bot-status">', '</section>');

    expect(divBlock(status, '<div class="card system-status">')).toContain('id="twitch-channels"');
    expect(html).not.toContain('<h2 class="section-title">Channels</h2>');
  });

  it('puts Stream Overview first in the right-hand column, apart from System Status, starting Unknown (#1114)', async () => {
    const html = await render();
    const side = divBlock(html, '<div class="dashboard-side">');
    const stream = between(side, '<section class="section dashboard-stream"', '</section>');

    // Source order: the column follows System Status, with Stream Overview ahead of the feed.
    expect(html.indexOf('id="bot-status"')).toBeLessThan(html.indexOf('<div class="dashboard-side">'));
    expect(side.indexOf('id="stream-overview"')).toBeLessThan(side.indexOf('<aside class="dashboard-sidebar"'));
    expect(between(html, '<section class="section dashboard-status" id="bot-status">', '</section>')).not.toContain('stream-overview');
    // Its own heading, labelled by it, and its own state: it starts Unknown, never Live or Offline.
    expect(stream).toContain('aria-labelledby="stream-overview-title"');
    expect(stream).toContain('<h2 class="section-title" id="stream-overview-title">Stream Overview</h2>');
    expect(stream).toContain('class="stream-state stream-state--unknown" id="stream-own-state" aria-live="polite">Unknown</p>');
    for (const id of ['stream-own-name', 'stream-own-note', 'stream-own-link']) expect(stream).toContain(`id="${id}"`);
    // It shares nothing with System Status: no dots, services, state text or stat rows.
    expect(stream).not.toMatch(/class="[^"]*\b(dot|service|status-text|stat-row|stat-value|badge)\b/);
  });

  it('uncaps and unsticks the right-hand column on short desktop windows, so the feed keeps its 6rem floor (#1114)', () => {
    const css = fs.readFileSync(stylePath, 'utf8');
    const short = /@media \(max-height: (\d+)px\) \{([\s\S]*?)\n\}/.exec(css);

    // Below this the column's cap would leave the feed less than its floor and the card (which clips) would cut it off.
    expect(Number(short?.[1])).toBeGreaterThanOrEqual(660);
    expect(short?.[2]).toMatch(/\.dashboard-side\s*\{[^}]*position:\s*static;[^}]*max-height:\s*none;/);
    expect(short?.[2]).toMatch(/\.dashboard-events-body\s*\{[^}]*max-height:\s*50vh;/);
  });

  it('is about the user\'s own channel only: no list of other channels, and the Twitch rows keep their LIVE badge (#1114)', async () => {
    const html = await render();
    const stream = between(html, '<section class="section dashboard-stream"', '</section>');

    expect(stream).not.toMatch(/Live now|<ul|<li|stream-live/);
    expect(fs.readFileSync(path.join(__dirname, '../../public/dashboard-status.js'), 'utf8')).toContain("liveBadge.textContent = 'LIVE'");
  });

  it('loads the Stream Overview script before the status script that calls it (#1114)', async () => {
    const html = await render();

    expect(html.indexOf('/dashboard-stream.js')).toBeGreaterThan(html.indexOf('/dashboard-health.js'));
    expect(html.indexOf('/dashboard-stream.js')).toBeLessThan(html.indexOf('/dashboard-status.js'));
  });

  it('puts the user\'s own channel on the body only when they have one, escaped (#1114)', async () => {
    expect(await render({ ownChannel: 'streamer_one' })).toMatch(/<body [^>]*data-own-channel="streamer_one">/);
    expect(await render({ ownChannel: null })).not.toContain('data-own-channel');
    expect(await render({ ownChannel: '"><script>' })).not.toContain('<script>');
  });

  it('styles each Stream Overview state with its own icon, hidden from screen readers, and never status red, amber or green (#1114)', () => {
    const css = fs.readFileSync(stylePath, 'utf8');

    for (const [modifier, icon] of [['live', '\\\\25C9'], ['offline', '\\\\25C7'], ['unknown', '\\?'], ['unavailable', '\\\\2013']]) {
      expect(css).toMatch(new RegExp(`\\.stream-state--${modifier}::before\\s*\\{[^}]*content:\\s*"${icon}"\\s*/\\s*""`));
    }
    const rules = (css.match(/\n\.stream-[a-z-]+[^{]*\{[^}]*\}/g) ?? []).join('\n');
    expect(rules).not.toMatch(/--danger|--success|--warning/);
    // Nothing in it moves, so it needs no reduced-motion exception.
    expect(rules).not.toMatch(/animation|transition/);
  });

  it('presents the bot\'s services as one System Status panel, with Last Played beside it and no overall badge (#1076)', async () => {
    const html = await render();
    const status = between(html, '<section class="section dashboard-status" id="bot-status">', '</section>');
    const panel = divBlock(status, '<div class="card system-status">');

    expect(html.match(/<h2 class="section-title">System Status<\/h2>/g)).toHaveLength(1);
    expect(html).not.toContain('Bot Status');
    // One panel holding exactly the three services, each with the ids the status script writes to.
    expect(panel.match(/<div class="service service--/g)).toHaveLength(3);
    for (const id of ['card-discord', 'card-voice', 'card-twitch', 'dot-discord', 'discord-state', 'discord-tag', 'discord-guild',
      'dot-voice', 'voice-state', 'voice-channel', 'twitch-state', 'twitch-channels']) {
      expect(panel).toContain(`id="${id}"`);
    }
    // Last Played is playback information, not a service: beside the panel, inside the section (so staleness mutes it).
    expect(status).toContain('class="card last-played"');
    expect(panel).not.toContain('last-command');
    for (const id of ['last-command', 'last-file', 'last-source', 'last-when']) expect(status).toContain(`id="${id}"`);
    // No second overall status, no Active Services card, no sparklines, no Hytale row.
    expect(status).not.toMatch(/All Good|All Systems Operational|Active Services|<svg|<canvas|Hytale/i);
  });

  it('keeps each service\'s state on its header line, beside its dot, so the panel stays compact (#1076)', async () => {
    const html = await render();

    for (const service of ['discord', 'voice']) {
      const header = between(divBlock(html, `<div class="service service--${service}"`), '<div class="service-header">', '<div class="service-body">');
      expect(header).toContain(`id="${service}-state"`);
      expect(header).toContain(`id="dot-${service}"`);
    }
    expect(between(html, '<div class="service service--twitch"', 'id="twitch-channels"')).toContain('id="twitch-state"');
  });

  it('puts the sections in source order System Status, events sidebar, Quick Links, Usage', async () => {
    const layout = divBlock(await render(), '<div class="dashboard-layout">');

    const positions = [
      '<section class="section dashboard-status" id="bot-status">',
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

  it('sizes the Twitch channel list from the height its column has, so it grows into spare height and never stretches the row (#1076)', async () => {
    const html = await render();
    const css = fs.readFileSync(stylePath, 'utf8');
    const list = /\n\.dashboard-twitch-body\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';

    expect(html).toMatch(/class="[^"]*\bdashboard-twitch-body\b[^"]*" id="twitch-channels"/);
    // `flex: 1 1 0px`, never `flex: 1`: a 0% basis becomes the content's height when the container's is indefinite,
    // which would stretch the row and push Quick Links down. The 7rem floor is what shows when nothing is spare.
    expect(list).toMatch(/flex:\s*1 1 0px;/);
    expect(list).toMatch(/min-height:\s*7rem;/);
    expect(list).toMatch(/overflow-y:\s*auto/);
    expect(list).not.toContain('max-height');
    // The status row is the 1fr one, stretched, with min-height: 0 down the chain, so the spare height lands there.
    expect(css).toMatch(/\.dashboard-layout\s*\{[^}]*grid-template-rows:\s*1fr auto auto;/);
    expect(css).toMatch(/\.dashboard-status\s*\{[^}]*align-self:\s*stretch;[^}]*container-type:\s*inline-size/);
    for (const rule of ['status-layout', 'system-status', 'service']) {
      expect(new RegExp(`\\n\\.${rule}\\s*\\{[^}]*min-height:\\s*0;`).test(css)).toBe(true);
    }
  });

  it('lays the panel out by its own width: stacked on phones, two columns wider, with Last Played beside it when there is room (#1076)', () => {
    const css = fs.readFileSync(stylePath, 'utf8');

    expect(css).toMatch(/@container \(min-width: 40rem\) \{[^@]*grid-template-areas:\s*"discord twitch" "voice twitch"/);
    expect(css).toMatch(/@container \(min-width: 60rem\) \{[^@]*\.status-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 15rem/);
    // Phones stack, and there the page scrolls anyway, so the list gets a fixed height instead.
    expect(css).toMatch(/@container \(max-width: 39\.99rem\) \{[^@]*\.dashboard-twitch-body\s*\{[^}]*max-height:\s*13\.5rem/);
    // One line per channel: the name, then its time, then its badges.
    expect(css).toMatch(/\.channel-info\s*\{[^}]*display:\s*flex;/);
    expect(css).toMatch(/\.channel-meta\s*\{[^}]*white-space:\s*nowrap/);
  });

  it('puts a connection roll-up above the Twitch channel list, outside its scroll region (#1074)', async () => {
    const html = await render();
    const rollup = html.indexOf('id="twitch-state"');

    expect(html).toMatch(/<h3 class="service-label">Twitch Channels<\/h3>\s*<span class="stat-value status-text" id="twitch-state">/);
    expect(rollup).toBeGreaterThan(html.indexOf('id="card-twitch"'));
    expect(rollup).toBeLessThan(html.indexOf('id="twitch-channels"'));
    // The scroll region keeps its label and focus stop, and the Usage tile keeps its count.
    expect(html).toMatch(/id="twitch-channels" tabindex="0" role="region" aria-label="Twitch channels"/);
    expect(html).toMatch(/<span class="stat-big">\d+<\/span><span class="stat-big-label">Twitch Channels<\/span>/);
  });

  it.each([
    ['connected', '\\\\2713'],
    ['degraded', '\\\\25B2'],
    ['disconnected', '\\\\2715'],
    ['inactive', '\\\\25CB'],
    ['unknown', '\\?'],
  ])('gives the %s roll-up state an icon, hidden from screen readers, so no state rests on colour alone (#1074)', (modifier, icon) => {
    const css = fs.readFileSync(stylePath, 'utf8');

    // `icon` is already escaped for a RegExp: the rule reads `content: "\2713" / "";` (an empty alt text hides it).
    expect(css).toMatch(new RegExp(`\\.status-text--${modifier}::before\\s*\\{[^}]*content:\\s*"${icon}"\\s*/\\s*""`));
  });

  it('styles the Degraded roll-up with its own icon and the warning colour, and lets a long state wrap (#1074)', () => {
    const css = fs.readFileSync(stylePath, 'utf8');

    expect(css).toMatch(/\.status-text--degraded\s*\{\s*color:\s*var\(--warning\);\s*\}/);
    expect(css).toMatch(/\.status-text--degraded::before\s*\{\s*content:\s*"\\25B2";\s*content:\s*"\\25B2"\s*\/\s*"";/);
    expect(css).toMatch(/\.service-header \.stat-value\s*\{[^}]*white-space:\s*normal/);
  });

  it('caps the right-hand column to leave room for the navbar, the health indicator and the footer, and lets the feed take what the panel leaves (#1114)', () => {
    const css = fs.readFileSync(stylePath, 'utf8');
    const desktopRules = css.slice(0, css.indexOf('@media (max-width: 1100px)'));
    const cap = /\.dashboard-side\s*\{[^}]*max-height:\s*calc\(100vh - var\(--dashboard-nav-offset\) - var\(--dashboard-health-offset\) - ([\d.]+)rem\)/.exec(desktopRules);

    // A static guard on the stylesheet, not a rendered check (the suite has no browser). The column holds Stream
    // Overview and the feed with its title and card chrome (~2.6rem, inside the column), so its reserve is the old 12rem
    // feed cap less that chrome: 9.375rem. A smaller reserve makes the page overflow by a few pixels (a stray page
    // scrollbar) when the feed is the tallest column. If the footer or the feed's chrome grows, re-measure in a browser
    // and raise the reserve and this floor.
    expect(Number(cap?.[1])).toBeGreaterThanOrEqual(9.125);
    // The feed itself has no cap of its own any more: it takes the column's height, down to its 6rem floor, and every
    // flex link in between has min-height: 0 so the feed's content can't size the column and grow the page.
    const feed = /\n\.dashboard-events-body\s*\{([^}]*)\}/.exec(desktopRules)?.[1] ?? '';
    expect(feed).toMatch(/flex:\s*1 1 auto;/);
    expect(feed).toMatch(/min-height:\s*6rem;/);
    expect(feed).not.toContain('max-height');
    for (const rule of ['\\.dashboard-side > \\.dashboard-sidebar', '\\.dashboard-sidebar > \\.dashboard-events', '\\.dashboard-events > \\.card']) {
      expect(new RegExp(`\\n${rule}\\s*\\{[^}]*min-height:\\s*0;`).test(desktopRules)).toBe(true);
    }
    // A squeezed column must not shrink a heading away to nothing.
    expect(desktopRules).toMatch(/\.dashboard-sidebar \.section-title,\s*\.dashboard-stream \.section-title\s*\{[^}]*flex:\s*none;/);
  });

  it('reserves room for the health indicator above the grid in the feed cap (#1130)', () => {
    const css = fs.readFileSync(stylePath, 'utf8');
    const reserve = /--dashboard-health-offset:\s*([\d.]+)rem/.exec(css);
    const health = /\n\.health\s*\{[^}]*margin-bottom:\s*([\d.]+)rem;\s*padding:\s*([\d.]+)rem[^}]*\}/.exec(css);

    // The indicator's height is its margin, its top and bottom padding, a 1px border either side (0.125rem) and one
    // line of text (the body's 14px at line-height 1.5 = 1.3125rem). The reserve must cover all of it, or the feed
    // grows past the viewport and the page scrolls again. Changing .health's spacing fails this until the reserve follows.
    const indicator = Number(health?.[1]) + 2 * Number(health?.[2]) + 0.125 + 1.3125;
    expect(Number(reserve?.[1])).toBeGreaterThanOrEqual(indicator);
    expect(Number(reserve?.[1])).toBeLessThanOrEqual(indicator + 0.25);
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

describe('dashboard status cues without colour or motion', () => {
  const css = fs.readFileSync(stylePath, 'utf8');

  it('gives both status dots an image role and a name in words from the first render', async () => {
    const html = await render();

    expect(html).toMatch(/class="dot dot--offline" id="dot-discord" role="img" aria-label="Discord: Disconnected"/);
    expect(html).toMatch(/class="dot dot--inactive" id="dot-voice" role="img" aria-label="Voice: Not connected"/);
  });

  it('draws each dot state as a different shape, not only a different colour', () => {
    // filled disc = connected, hollow ring = disconnected/inactive, play triangle = playing
    expect(css).toMatch(/\.dot--offline\s*\{[^}]*background:\s*transparent;[^}]*border:\s*2px solid/);
    expect(css).toMatch(/\.dot--inactive\s*\{[^}]*background:\s*transparent;[^}]*border:\s*2px solid var\(--muted\)/);
    expect(css).toMatch(/\.dot--playing\s*\{[^}]*clip-path:\s*polygon\(/);
  });

  it.each([
    ['badge-online', '\\2713'],
    ['badge-offline', '\\2715'],
    ['badge-live', '\\25CF'],
  ])('puts a decorative icon on the %s channel badge, hidden from screen readers', (cls, icon) => {
    const rule = new RegExp(`\\.channel-badges \\.${cls}::before\\s*\\{[^}]*content:\\s*"\\${icon}"\\s*/\\s*""`);

    expect(css).toMatch(rule);
  });

  it('stops every animation and transition when the OS asks for reduced motion', () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';

    expect(reduced).toMatch(/\*, \*::before, \*::after\s*\{[^}]*animation:\s*none !important;[^}]*transition:\s*none !important;/);
  });
});

describe('Discord and Voice card text states', () => {
  const css = fs.readFileSync(stylePath, 'utf8');

  it('gives the Discord and Voice services a state in words on their header line, both neutral until status loads', async () => {
    const discord = divBlock(await render(), '<div class="service service--discord" id="card-discord">');
    const voice = divBlock(await render(), '<div class="service service--voice" id="card-voice">');

    expect(discord).toContain('<span class="stat-value status-text" id="discord-state">—</span>');
    expect(voice).toContain('<span class="stat-value status-text" id="voice-state">—</span>');
    // Every id the status script writes to is still there.
    for (const id of ['dot-discord', 'discord-tag', 'discord-guild']) expect(discord).toContain(`id="${id}"`);
    for (const id of ['dot-voice', 'voice-channel']) expect(voice).toContain(`id="${id}"`);
  });

  it.each([
    ['connected', '\\2713'],
    ['disconnected', '\\2715'],
    ['inactive', '\\25CB'],
    ['idle', '\\25CF'],
    ['playing', '\\25B6'],
  ])('gives the %s state text its own icon, hidden from screen readers', (modifier, icon) => {
    const rule = new RegExp(`\\.status-text--${modifier}::before\\s*\\{[^}]*content:\\s*"\\${icon}"\\s*/\\s*""`);

    expect(css).toMatch(rule);
  });

  it('keeps status red/amber off the informational voice states', () => {
    for (const cls of ['status-text--inactive', 'status-text--idle', 'status-text--playing', 'dot--inactive', 'dot--playing']) {
      const rule = new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';

      expect(rule).not.toBe('');
      expect(rule).not.toMatch(/--danger|--warning/);
    }
  });

  it.each([
    [0, false],
    [1, true],
    [3, true],
  ])('shows the voice channel selector and Join/Leave button only to Mod+ (access level %i)', async (accessLevel, shown) => {
    const voice = divBlock(await render({ user: { ...USER, accessLevel } }), '<div class="service service--voice" id="card-voice">');

    expect(voice.includes('id="voice-channel-select"')).toBe(shown);
    expect(voice.includes('id="btn-rejoin-voice"')).toBe(shown);
  });

  it('keeps the Last Played card and its fields', async () => {
    const html = await render();

    for (const id of ['last-command', 'last-file', 'last-source', 'last-when']) expect(html).toContain(`id="${id}"`);
  });
});

describe('overall health indicator', () => {
  const css = fs.readFileSync(stylePath, 'utf8');

  it('renders exactly one indicator, as a polite live region above the dashboard layout', async () => {
    const html = await render();

    expect(html.match(/id="health-indicator"/g)).toHaveLength(1);
    expect(html).toMatch(/<div id="health-indicator" class="health health--unknown" data-state="unknown" role="status">Status unknown<\/div>/);
    expect(html.indexOf('id="health-indicator"')).toBeLessThan(html.indexOf('<div class="dashboard-layout">'));
  });

  it.each([
    ['signed in', {}],
    ['signed out', { user: null }],
  ])('never claims health in the server render (%s): it starts Unknown until data arrives', async (_case, locals) => {
    const html = await render(locals);

    expect(html).not.toContain('All Systems Operational');
    expect(html).toContain('>Status unknown</div>');
  });

  it('has a hidden note on System Status for when the feed is unreachable', async () => {
    const status = between(await render(), '<section class="section dashboard-status" id="bot-status">', '</section>');

    expect(status).toContain('<p id="status-stale-note" class="status-stale-note" hidden>');
  });

  it('loads the health script before the status script that calls it', async () => {
    const html = await render();

    expect(html.indexOf('<script src="/dashboard-health.js">')).toBeGreaterThan(-1);
    expect(html.indexOf('<script src="/dashboard-health.js">')).toBeLessThan(html.indexOf('<script src="/dashboard-status.js">'));
  });

  it.each([
    ['healthy', '\\2713'],
    ['degraded', '\\25B2'],
    ['unhealthy', '\\2715'],
    ['unknown', '?'],
  ])('gives the %s state its own icon, hidden from screen readers', (state, icon) => {
    const escaped = icon.replace(/[\\?]/g, (c) => `\\${c}`);
    const rule = new RegExp(`\\.health--${state}::before\\s*\\{[^}]*content:\\s*"${escaped}"\\s*/\\s*""`);

    expect(css).toMatch(rule);
  });

  it('keeps Unknown neutral grey, never green', () => {
    expect(css).toMatch(/\.health--unknown\s*\{\s*color:\s*var\(--muted\);\s*\}/);
  });

  it('mutes stale values by colour, not opacity, so text keeps its contrast', () => {
    const staleRules = css.match(/\.is-stale[^{]*\{[^}]*\}/g) ?? [];

    expect(staleRules.length).toBeGreaterThan(0);
    for (const rule of staleRules) expect(rule).not.toMatch(/opacity/);
    expect(css).toMatch(/\.dot--unknown\s*\{[^}]*border:\s*2px dashed/);
  });

  it('mutes every kind of System Status value while stale, including the Twitch channel rows and their badges', () => {
    for (const selector of ['.is-stale .stat-value', '.is-stale .channel-name', '.is-stale .channel-meta']) {
      expect(css).toContain(selector);
    }
    // Badges lose their fill and the LIVE pulse stops, so a stale LIVE neither reads as current nor drops below AA.
    expect(css).toMatch(/\.is-stale \.badge\s*\{[^}]*background:\s*transparent;[^}]*color:\s*var\(--muted\);[^}]*animation:\s*none;/);
  });
});
