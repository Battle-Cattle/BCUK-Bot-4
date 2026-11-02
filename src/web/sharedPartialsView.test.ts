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
    const footer = html.indexOf('<footer');
    const utils = html.indexOf('<script src="/utils.js"></script>');
    expect(footer).toBeGreaterThan(-1);
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

  it('shows "Not connected" and loads no status scripts when the streamer has no Twitch login', async () => {
    const html = await render('obsBrowserSource', { streamer: { twitch_name: null }, baseUrl: 'https://bot.example', overlayPath: 'overlay' });
    expect(html).toContain('Not connected');
    expect(html).not.toContain('overlayConnectionStatus.js');
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
