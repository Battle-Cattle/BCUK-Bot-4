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
    expect(fs.readFileSync(path.join(__dirname, '../../public/dashboard-status.js'), 'utf8')).toContain("liveBadge.textContent = liveStale ? 'WAS LIVE' : 'LIVE'");
  });

  it('loads the Stream Overview script before the status script that calls it (#1114)', async () => {
    const html = await render();

    expect(html.indexOf('/dashboard-stream.js')).toBeGreaterThan(html.indexOf('/dashboard-health.js'));
    expect(html.indexOf('/dashboard-stream.js')).toBeLessThan(html.indexOf('/dashboard-status.js'));
  });

  it('has the own-channel stats block inside Your channel: four rows hidden until the stream sends values, title and category in <bdi> (#1184)', async () => {
    const html = await render({ ownChannel: 'streamer_one' });
    const own = divBlock(html, '<div class="stream-own" id="stream-own">');

    const block = between(own, '<dl class="stream-stats" id="stream-stats" hidden>', '</dl>');
    for (const name of ['viewers', 'uptime', 'category', 'title']) {
      expect(block).toContain(`id="stream-stat-${name}" hidden`);
      expect(block).toContain(`id="stream-stat-${name}-value"`);
    }
    expect(block).toContain('<bdi id="stream-stat-title-value"></bdi>');
    expect(block).toContain('<bdi id="stream-stat-category-value"></bdi>');
    expect(block).toMatch(/<dt>Viewers<\/dt>[\s\S]*<dt>Uptime<\/dt>[\s\S]*<dt>Category<\/dt>[\s\S]*<dt>Title<\/dt>/);
    expect(own).toContain('<p class="stream-note" id="stream-stats-note" hidden></p>');
    // Nothing from the server is written into it: the script fills it from the stream.
    expect(block).not.toMatch(/<%/);
  });

  it('loads the stats script after the context watcher and the Stream Overview script it uses, once (#1184)', async () => {
    const html = await render({ ownChannel: 'streamer_one' });
    const at = (name: string) => html.indexOf(`<script src="/${name}.js"></script>`);

    expect(at('dashboard-stream-stats')).toBeGreaterThan(at('dashboard-context'));
    expect(at('dashboard-stream-stats')).toBeGreaterThan(at('dashboard-stream'));
    expect(html.match(/<script src="\/dashboard-stream-stats\.js"><\/script>/g)).toHaveLength(1);
  });

  it('styles the stats so Twitch\'s text can never widen the panel: anywhere-wrapping, and the title on two lines (#1184)', () => {
    const css = fs.readFileSync(stylePath, 'utf8');

    expect(css).toMatch(/\.stream-stat dd\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.stream-stat--wide dd\s*\{[^}]*-webkit-line-clamp:\s*2[^}]*overflow:\s*hidden/);
    expect(css).toMatch(/\.stream-stats\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    expect(css).toMatch(/\.stream-stats\[hidden\][^{]*\{\s*display:\s*none/);
  });

  it('loads the last-played script after the utils it uses and before the status script that calls it (#1141)', async () => {
    const html = await render();
    const at = (name: string) => html.indexOf(`<script src="/${name}.js"></script>`);

    expect(at('dashboard-last-played')).toBeGreaterThan(at('dashboard-utils'));
    expect(at('dashboard-last-played')).toBeLessThan(at('dashboard-status'));
    expect(html.match(/dashboard-last-played\.js/g)).toHaveLength(1);
  });

  it('loads the context-change script before the two scripts that open the dashboard streams', async () => {
    const html = await render();

    expect(html.indexOf('/dashboard-context.js')).toBeGreaterThan(-1);
    expect(html.indexOf('/dashboard-context.js')).toBeLessThan(html.indexOf('/dashboard-events.js'));
    expect(html.indexOf('/dashboard-context.js')).toBeLessThan(html.indexOf('/app.js'));
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

  it('draws the LIVE dot as a shape centred on its label, not a text glyph, and drops the Stream Overview\'s purple edge (#1148, #1140)', () => {
    const css = fs.readFileSync(stylePath, 'utf8');
    const dot = /\.channel-badges \.badge-live::before,\s*\.channel-badges \.badge-live-stale::before\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';

    expect(dot).toMatch(/content:\s*"";/);
    // Filled when live, an outlined ring when the check is stale ("was live"): two shapes, not just two colours.
    expect(css).toMatch(/\.channel-badges \.badge-live::before\s*\{\s*background:\s*currentColor;/);
    expect(css).toMatch(/\.channel-badges \.badge-live-stale::before\s*\{\s*border:\s*1\.5px solid currentColor;/);
    expect(dot).toMatch(/width:\s*\.5em;\s*height:\s*\.5em;\s*border-radius:\s*50%/);
    expect(css).toMatch(/\.channel-badges \.badge\s*\{[^}]*display:\s*inline-flex;\s*align-items:\s*center;/);
    // No text glyph for the dot any more (the Connected and Disconnected ticks and crosses stay).
    expect(css).not.toMatch(/\.badge-live(-stale)?::before\s*\{[^}]*"\\25(CF|CB)"/);
    expect(css).not.toMatch(/\.stream-card\s*\{[^}]*border/);
  });

  it('presents the bot\'s services as one System Status panel, with the last sound inside the Voice service (#1076, #1141)', async () => {
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
    // The last sound is a line inside the Voice service (so staleness mutes it); the separate Last Played card is gone.
    expect(divBlock(panel, '<div class="service service--voice"')).toContain('id="voice-last-played"');
    expect(status).not.toContain('class="card last-played"');
    for (const id of ['last-command', 'last-file', 'last-source', 'last-when']) expect(status).not.toContain(`id="${id}"`);
    // No second overall status, no Active Services card, no sparklines, no Hytale row.
    expect(status).not.toMatch(/All Good|Active Services|<svg|<canvas|Hytale/i);
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

  it('puts the sections in source order welcome hero, System Status, events sidebar', async () => {
    const layout = divBlock(await render(), '<div class="dashboard-layout">');

    const positions = [
      '<section class="dashboard-hero"',
      '<section class="section dashboard-status" id="bot-status">',
      '<aside class="dashboard-sidebar"',
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
    expect(narrowRules).toMatch(/grid-template-areas:\s*"hero" "status" "events"[^"]/);
  });

  it('keeps the welcome hero in the left column on desktop, above System Status', () => {
    const css = fs.readFileSync(stylePath, 'utf8');

    expect(css).toMatch(/grid-template-areas:\s*"hero events" "status events"[^"]/);
    expect(css).toMatch(/\.dashboard-hero\s*\{[^}]*grid-area:\s*hero/);
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
    // which would stretch the row and push the page taller. The 7rem floor is what shows when nothing is spare.
    expect(list).toMatch(/flex:\s*1 1 0px;/);
    expect(list).toMatch(/min-height:\s*7rem;/);
    expect(list).toMatch(/overflow-y:\s*auto/);
    expect(list).not.toContain('max-height');
    // The status row is the 1fr one (below the hero), stretched, with min-height: 0 down the chain, so the spare height lands there.
    expect(css).toMatch(/\.dashboard-layout\s*\{[^}]*grid-template-rows:\s*auto 1fr;/);
    expect(css).toMatch(/\.dashboard-status\s*\{[^}]*align-self:\s*stretch;[^}]*container-type:\s*inline-size/);
    for (const rule of ['status-layout', 'system-status', 'service']) {
      expect(new RegExp(`\\n\\.${rule}\\s*\\{[^}]*min-height:\\s*0;`).test(css)).toBe(true);
    }
  });

  it('lays the panel out by its own width: stacked on phones and two columns wider (#1076)', () => {
    const css = fs.readFileSync(stylePath, 'utf8');

    expect(css).toMatch(/@container \(min-width: 40rem\) \{[^@]*grid-template-areas:\s*"discord twitch" "voice twitch"/);
    // No third column for Last Played any more: it is a line inside the Voice service.
    expect(css).not.toContain('@container (min-width: 60rem)');
    // Phones stack, and there the page scrolls anyway, so the list gets a fixed height instead.
    expect(css).toMatch(/@container \(max-width: 39\.99rem\) \{[^@]*\.dashboard-twitch-body\s*\{[^}]*max-height:\s*13\.5rem/);
    // One line per channel: the name, then its time, then its badges.
    expect(css).toMatch(/\.channel-info\s*\{[^}]*display:\s*flex;/);
    expect(css).toMatch(/\.channel-meta\s*\{[^}]*white-space:\s*nowrap/);
  });

  it('gives the Twitch service a status dot in its header like Discord and Voice, with a role and a name (#1137)', async () => {
    const html = await render();
    const header = between(html, '<div class="service service--twitch"', 'id="twitch-channels"');

    expect(header).toMatch(/<span class="dot dot--unknown" id="dot-twitch" role="img" aria-label="Twitch: Status unknown" title="Twitch: Status unknown"><\/span>/);
    expect(header.indexOf('id="twitch-state"')).toBeLessThan(header.indexOf('id="dot-twitch"'));
  });

  it('gives each Twitch dot state a shape of its own, the degraded one a triangle (#1137)', () => {
    const css = fs.readFileSync(stylePath, 'utf8');

    expect(css).toMatch(/\.dot--degraded\s*\{[^}]*clip-path:\s*polygon\(50% 0, 100% 100%, 0 100%\)/);
    expect(css).not.toMatch(/\.dot--degraded\s*\{[^}]*animation/);
  });

  it('keeps a Reconnect link in the Twitch service only while the viewer\'s Twitch token needs reconnecting (#1136)', async () => {
    const needs = await render({ needsReconnect: true });
    const card = divBlock(needs, '<div class="service service--twitch"');

    expect(card).toMatch(/<a href="\/user\/settings\/twitch-connect" class="btn btn-sm" id="twitch-reconnect-link">Reconnect your Twitch account<\/a>/);
    // It sits outside the scroll region, so the list's own scrolling never hides it.
    expect(card.indexOf('id="twitch-reconnect-link"')).toBeGreaterThan(card.indexOf('id="twitch-channels"'));
    expect(divBlock(card, '<div class="service-body dashboard-twitch-body dashboard-scroll" id="twitch-channels"')).not.toContain('twitch-reconnect-link');
    // The modal is unchanged.
    expect(needs).toContain('id="reconnect-modal"');

    const fine = await render({ needsReconnect: false });
    expect(fine).not.toContain('twitch-reconnect-link');
    expect(fine).not.toContain('Reconnect your Twitch account');
  });

  it('puts a connection roll-up above the Twitch channel list, outside its scroll region (#1074)', async () => {
    const html = await render();
    const rollup = html.indexOf('id="twitch-state"');

    expect(html).toMatch(/<h3 class="service-label">Twitch Channels<\/h3>\s*<span class="stat-value status-text" id="twitch-state">/);
    expect(rollup).toBeGreaterThan(html.indexOf('id="card-twitch"'));
    expect(rollup).toBeLessThan(html.indexOf('id="twitch-channels"'));
    // The scroll region keeps its label and focus stop.
    expect(html).toMatch(/id="twitch-channels" tabindex="0" role="region" aria-label="Twitch channels"/);
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

  it('caps the right-hand column to leave room for the navbar, and the footer, and lets the feed take what the panel leaves (#1114)', () => {
    const css = fs.readFileSync(stylePath, 'utf8');
    const desktopRules = css.slice(0, css.indexOf('@media (max-width: 1100px)'));
    const cap = /\.dashboard-side\s*\{[^}]*max-height:\s*calc\(100vh - var\(--dashboard-nav-offset\) - ([\d.]+)rem\)/.exec(desktopRules);

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

  it('reserves nothing for the health indicator any more: it sits on the System Status heading row, not above the grid (#1178)', () => {
    const css = fs.readFileSync(stylePath, 'utf8');

    expect(css).not.toContain('--dashboard-health-offset');
    // The pill is compact, and has no bottom margin of its own that would add a row's worth of height.
    const health = /\n\.health\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(health).not.toContain('margin-bottom');
    expect(health).toMatch(/padding:\s*\.2rem \.75rem/);
  });

  it('gives the feed cap the stale note\'s height while the note shows, so the page keeps no scrollbar when the feed is down (#1134)', () => {
    const css = fs.readFileSync(stylePath, 'utf8');
    const reserve = /--dashboard-stale-note-offset:\s*([\d.]+)rem/.exec(css);
    const note = /\n\.status-stale-note\s*\{[^}]*margin-bottom:\s*([\d.]+)rem;\s*padding:\s*([\d.]+)rem[^}]*font-size:\s*([\d.]+)rem/.exec(css);
    const capRule = /\.dashboard-layout:has\(> \.dashboard-status\.is-stale\) > \.dashboard-side\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';

    // The note's height is its bottom margin, both paddings and one line of text at the body's 1.5 line height. The
    // reserve must cover it, or the page scrolls again just when the feed is unreachable.
    const height = Number(note?.[1]) + 2 * Number(note?.[2]) + 1.5 * Number(note?.[3]);
    expect(Number(reserve?.[1])).toBeGreaterThanOrEqual(height);
    expect(Number(reserve?.[1])).toBeLessThanOrEqual(height + 0.25);
    // It is taken off the same cap as the normal reserve, and only while the status section is marked stale.
    expect(capRule).toMatch(/max-height:\s*calc\(100vh - var\(--dashboard-nav-offset\) - 9\.375rem - var\(--dashboard-stale-note-offset\)\)/);
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

  it('puts the last-played line in the Voice service, starting as a dash until status loads, and drops the old card (#1141)', async () => {
    const html = await render();
    const voice = divBlock(html, '<div class="service service--voice"');

    expect(voice).toMatch(/<p class="last-played"><span class="stat-label">Last played<\/span> <span class="last-played-line" id="voice-last-played">—<\/span><\/p>/);
    expect(html).not.toContain('Last Played');
    for (const id of ['last-command', 'last-file', 'last-source', 'last-when']) expect(html).not.toContain(`id="${id}"`);
  });

  it('renders no user-controlled name on the server: the line is filled by the script as text (#1141)', async () => {
    const html = await render({ status: { voice: { connected: false, lastUser: '<script>x</script>', lastChannel: 'secret' }, twitch: {} } });
    const voice = divBlock(html, '<div class="service service--voice"');

    expect(voice).not.toContain('<script>x');
    expect(voice).toContain('id="voice-last-played">—<');
  });

  it('draws the last-played line without a status colour, one wrapping line with isolated names (#1141)', () => {
    const css = fs.readFileSync(stylePath, 'utf8');
    const rules = (css.match(/\n\.last-played[^{]*\{[^}]*\}/g) ?? []).join('\n');

    expect(rules).not.toMatch(/--danger|--success|--warning/);
    expect(css).toMatch(/\.last-played-line bdi\s*\{[^}]*unicode-bidi:\s*isolate/);
    expect(css).toMatch(/\.last-played\s*\{[^}]*overflow-wrap:\s*anywhere/);
    // The time stays whole ("6d ago") however the line wraps.
    expect(css).toMatch(/\.last-played-line time\s*\{[^}]*white-space:\s*nowrap/);
  });
});

describe('overall health indicator', () => {
  const css = fs.readFileSync(stylePath, 'utf8');

  it('renders exactly one indicator, as a polite live region on the System Status heading row (#1178)', async () => {
    const html = await render();
    const status = between(html, '<section class="section dashboard-status" id="bot-status">', '</section>');

    expect(html.match(/id="health-indicator"/g)).toHaveLength(1);
    expect(html).toMatch(/<div id="health-indicator" class="health health--unknown" data-state="unknown" role="status">Status unknown<\/div>/);
    // On the heading row with the title, ahead of the stale note and the panel; nothing above the layout any more.
    expect(status).toMatch(/<div class="section-header">\s*<h2 class="section-title">System Status<\/h2>\s*<div id="health-indicator"[^>]*>Status unknown<\/div>\s*<\/div>/);
    expect(status.indexOf('id="health-indicator"')).toBeLessThan(status.indexOf('id="status-stale-note"'));
    expect(html.indexOf('<main class="container container--wide">')).toBeLessThan(html.indexOf('<div class="dashboard-layout">'));
    expect(between(html, '<main class="container container--wide">', '<div class="dashboard-layout">')).not.toContain('health');
  });

  it('leaves the navbar alone: the indicator is not in it (#1178)', async () => {
    const html = await render();
    expect(between(html, '<nav class="navbar">', '</nav>')).not.toContain('health');
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

describe('views/dashboard.ejs welcome hero', () => {
  /** The hero's HTML, from its opening tag to its closing `</section>`. */
  const heroOf = (html: string): string => between(html, '<section class="dashboard-hero"', '</section>');
  /** The destinations of every quick action in the hero, in order. */
  const hrefsOf = (hero: string): string[] => [...hero.matchAll(/<a href="([^"]+)" class="hero-action"/g)].map((m) => m[1] as string);

  it('greets the signed-in user by name in the page h1', async () => {
    const html = await render({ user: { ...USER, discordName: 'user1' } });

    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(heroOf(html)).toContain('<h1 class="hero-title" id="dashboard-welcome">Welcome back, user1!</h1>');
    expect(heroOf(html)).toContain('aria-labelledby="dashboard-welcome"');
  });

  it('escapes the display name', async () => {
    const html = await render({ user: { ...USER, discordName: '<b>x</b>' } });

    expect(heroOf(html)).toContain('Welcome back, &lt;b&gt;x&lt;/b&gt;!');
    expect(heroOf(html)).not.toContain('<b>x</b>');
  });

  it('shows a neutral greeting when signed out', async () => {
    const hero = heroOf(await render({ user: null }));

    expect(hero).toContain('>Welcome to BCUK Bot</h1>');
    expect(hero).not.toContain('Welcome back');
  });

  it('lists every existing quick link for a Manager and above', async () => {
    const hero = heroOf(await render({ user: { ...USER, accessLevel: 2 } }));

    expect(hrefsOf(hero)).toEqual(['/sfx', '/commands', '/counters', '/channel-points', '/loyalty-points', '/alerts/settings']);
  });

  it.each([[1], [0]])('leaves Commands and Counters out below Manager (access level %i)', async (accessLevel) => {
    const hero = heroOf(await render({ user: { ...USER, accessLevel } }));

    expect(hrefsOf(hero)).toEqual(['/sfx', '/channel-points', '/loyalty-points', '/alerts/settings']);
  });

  it('keeps the same four links for a signed-out visitor, as the old Quick Links did', async () => {
    expect(hrefsOf(heroOf(await render({ user: null })))).toEqual(['/sfx', '/channel-points', '/loyalty-points', '/alerts/settings']);
  });

  it('hides the emoji from assistive technology and drops the old Quick Links section', async () => {
    const html = await render();

    expect(heroOf(html).match(/class="hero-action-icon" aria-hidden="true"/g)).toHaveLength(6);
    expect(html).not.toContain('Quick Links</h2>');
    expect(html).not.toContain('quick-link-card');
  });

  it('shows the SFX, command and counter counts as chips on their own quick links (#1189)', async () => {
    const hero = heroOf(await render({ user: { ...USER, accessLevel: 2 }, usageStats: { sfxCount: 220, commandCount: 17, counterCount: 25 } }));

    expect(hero).toMatch(/<a href="\/sfx" class="hero-action">[^]*?SFX <span class="hero-count">220<\/span><\/a>/);
    expect(hero).toMatch(/<a href="\/commands" class="hero-action">[^]*?Commands <span class="hero-count">17<\/span><\/a>/);
    expect(hero).toMatch(/<a href="\/counters" class="hero-action">[^]*?Counters <span class="hero-count">25<\/span><\/a>/);
    // Only those three links get a count; the others and every destination are unchanged.
    expect(hero.match(/class="hero-count"/g)).toHaveLength(3);
    for (const href of ['/channel-points', '/loyalty-points', '/alerts/settings']) {
      expect(between(hero, `<a href="${href}"`, '</a>')).not.toContain('hero-count');
    }
  });

  it('shows the SFX chip wherever the SFX link shows, and the other two only for a Manager and above (#1189)', async () => {
    const hero = heroOf(await render({ user: { ...USER, accessLevel: 1 }, usageStats: { sfxCount: 220, commandCount: 17, counterCount: 25 } }));

    expect(hero.match(/class="hero-count"/g)).toHaveLength(1);
    expect(hero).toContain('SFX <span class="hero-count">220</span>');
    expect(hero).not.toContain('>17<');
    expect(hero).not.toContain('>25<');
  });

  it('keeps a zero count as 0 and a long one whole, so a chip never reads blank or cut (#1189)', async () => {
    const hero = heroOf(await render({ user: { ...USER, accessLevel: 2 }, usageStats: { sfxCount: 0, commandCount: 12345, counterCount: 5 } }));

    expect(hero).toContain('SFX <span class="hero-count">0</span>');
    expect(hero).toContain('Commands <span class="hero-count">12345</span>');
  });

  it('has no Usage row and no Twitch channel count any more (#1189)', async () => {
    const html = await render();
    const css = fs.readFileSync(stylePath, 'utf8');

    expect(html).not.toContain('dashboard-usage');
    expect(html).not.toContain('>Usage<');
    expect(html).not.toContain('twitch-channel-count');
    expect(html).not.toContain('stat-big');
    expect(css).not.toMatch(/dashboard-usage|\.stat-big|\.stat-card-body|\.status-grid/);
  });

  it('draws the chip as plain text on a pill, no status colour (#1189)', () => {
    const css = fs.readFileSync(stylePath, 'utf8');
    const chip = /\n\.hero-count\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';

    expect(chip).toMatch(/border-radius:\s*99px/);
    expect(chip).not.toMatch(/--danger|--success|--warning/);
  });
});
