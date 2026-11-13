import { describe, expect, it } from 'vitest';
import ejs from 'ejs';
import path from 'path';

const PARTIALS = path.join(__dirname, '../../views/partials');

const render = (name: string, data: Record<string, unknown>) => ejs.renderFile(path.join(PARTIALS, `${name}.ejs`), data);

describe('partials/head', () => {
  it('escapes the page title and pulls in the PWA head tags', async () => {
    const html = await render('head', { pageTitle: 'BCUK Bot: Privacy & Cookies' });
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('<title>BCUK Bot: Privacy &amp; Cookies</title>');
    expect(html).toContain('rel="manifest"');
    expect(html).not.toContain('</head>');
  });
});

describe('partials/page-end', () => {
  it('renders the service-worker registration, the footer and utils.js, in that order', async () => {
    const html = await render('page-end', {});
    const registration = html.indexOf('<script src="/pwa-register.js" defer></script>');
    const footer = html.indexOf('<footer');
    const utils = html.indexOf('<script src="/utils.js"></script>');
    expect(registration).toBeGreaterThan(-1);
    expect(footer).toBeGreaterThan(registration);
    expect(utils).toBeGreaterThan(footer);
  });
});

describe('partials/obsBrowserSource', () => {
  it('builds the browser-source URL and events stream from overlayPath and the lowercased login', async () => {
    const html = await render('obsBrowserSource', { streamer: { twitch_name: 'StreamerOne' }, baseUrl: 'https://bot.example', overlayPath: 'alerts' });
    expect(html).toContain('https://bot.example/alerts/streamerone</code>');
    expect(html).toContain('data-events-url="/alerts/settings/events"');
    expect(html).toContain('Checking…');
  });

  it('uses overlayPath for both the URL and the events stream on the overlay page', async () => {
    const html = await render('obsBrowserSource', { streamer: { twitch_name: 'StreamerOne' }, baseUrl: 'https://bot.example', overlayPath: 'overlay' });
    expect(html).toContain('https://bot.example/overlay/streamerone</code>');
    expect(html).toContain('data-events-url="/overlay/settings/events"');
    expect(html).not.toContain('/alerts/');
  });

  it('shows "Not connected" and loads no status scripts when the streamer has no Twitch login', async () => {
    const html = await render('obsBrowserSource', { streamer: { twitch_name: null }, baseUrl: 'https://bot.example', overlayPath: 'overlay' });
    expect(html).toContain('Not connected');
    expect(html).not.toContain('overlayConnectionStatus.js');
  });
});

describe('partials/obsBrowserSource options', () => {
  const streamer = { twitch_name: 'StreamerOne' };

  it('titles the card "OBS Browser Source" unless given a heading', async () => {
    const plain = await render('obsBrowserSource', { streamer, baseUrl: 'https://bot.example', overlayPath: 'overlay' });
    expect(plain).toContain('<h2 class="section-title">OBS Browser Source</h2>');
    const titled = await render('obsBrowserSource', { streamer, baseUrl: 'https://bot.example', overlayPath: 'overlay/shared', heading: 'Shared <Video> Overlay' });
    expect(titled).toContain('<h2 class="section-title">Shared &lt;Video&gt; Overlay</h2>');
  });

  it('shows the shared overlay URL for the lowercased login, without the status dot or its scripts, when showStatus is false', async () => {
    const html = await render('obsBrowserSource', { streamer, baseUrl: 'https://bot.example', overlayPath: 'overlay/shared', showStatus: false });
    expect(html).toContain('https://bot.example/overlay/shared/streamerone</code>');
    expect(html).not.toContain('overlay-status');
    expect(html).not.toContain('Checking…');
    expect(html).not.toContain('overlayConnectionStatus.js');
    expect(html).not.toContain('sseClient.js');
  });

  it('still shows the status dot by default', async () => {
    const html = await render('obsBrowserSource', { streamer, baseUrl: 'https://bot.example', overlayPath: 'overlay' });
    expect(html).toContain('id="overlay-status-dot"');
    expect(html).toContain('overlayConnectionStatus.js');
  });
});

describe('partials/assignedUserBadges', () => {
  const users = [
    { discord_id: '1', discord_name: 'Me', twitch_name: 'me_tv' },
    { discord_id: '2', discord_name: null, twitch_name: null, is_orphaned_user: true },
  ];

  it('marks the session user\'s own badge and labels an orphaned assignee', async () => {
    const html = await render('assignedUserBadges', { user: { discordId: '1' }, assignedUsers: users, emptyText: 'None' });
    expect(html).toMatch(/badge-user-self" data-user-hue="1">\s*Me\s*\(me_tv\)/);
    expect(html).toMatch(/badge badge-user-hue" data-user-hue="2">\s*2\s*\(missing user\)/);
  });

  it('shows emptyText when nobody is assigned', async () => {
    const html = await render('assignedUserBadges', { user: null, assignedUsers: [], emptyText: 'No streamers assigned' });
    expect(html).toContain('<span class="muted">No streamers assigned</span>');
    expect(html).not.toContain('badge-list-wrap');
  });
});

describe('partials/streamdeckKeyApproveDeny', () => {
  it('posts the requester\'s Discord id and the CSRF token to both approve and deny', async () => {
    const html = await render('streamdeckKeyApproveDeny', { csrfToken: 'tok', discordId: '42' });
    expect(html).toContain('action="/admin/streamdeck-keys/approve"');
    expect(html).toContain('action="/admin/streamdeck-keys/deny"');
    expect(html.match(/name="discord_id" value="42"/g)).toHaveLength(2);
    expect(html.match(/name="_csrf" value="tok"/g)).toHaveLength(2);
  });
});

describe('partials/notStreamerCard', () => {
  it('tells the user they are not a monitored streamer', async () => {
    const html = await render('notStreamerCard', {});
    expect(html).toContain('You are not configured as a monitored streamer.');
  });
});
