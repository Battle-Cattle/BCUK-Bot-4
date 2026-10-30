import { describe, it, expect } from 'vitest';
import path from 'path';
import ejs from 'ejs';

const viewPath = path.join(__dirname, '../../views/dashboard.ejs');

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

describe('views/dashboard.ejs layout', () => {
  it('puts the recent events feed in the sidebar, outside the main column', async () => {
    const html = await render();

    expect(between(html, '<aside class="dashboard-sidebar"', '</aside>')).toContain('id="recent-events-list"');
    expect(between(html, '<div class="dashboard-main">', '<aside')).not.toContain('id="recent-events-list"');
  });

  it('shows the Twitch channel status as a Bot Status card instead of a separate Channels section', async () => {
    const html = await render();

    expect(between(html, '<section class="section dashboard-status">', '</section>')).toContain('id="twitch-channels"');
    expect(html).not.toContain('<h2 class="section-title">Channels</h2>');
  });

  it('orders the main column Bot Status, then Quick Links, then Usage', async () => {
    const html = await render();
    const main = between(html, '<div class="dashboard-main">', '<aside');

    const status = main.indexOf('>Bot Status<');
    const links = main.indexOf('>Quick Links<');
    const usage = main.indexOf('>Usage<');
    expect(status).toBeGreaterThanOrEqual(0);
    expect(links).toBeGreaterThan(status);
    expect(usage).toBeGreaterThan(links);
  });

  it.each([
    ['signed out', { user: null }, 'Sign in to see recent activity.'],
    ['without a linked streamer', { hasStreamer: false }, 'Connect your Twitch account to see recent activity.'],
    ['with a streamer and no events', {}, 'No recent activity yet.'],
  ])('shows the right empty feed message %s', async (_case, locals, message) => {
    const html = await render(locals);

    expect(between(html, 'id="recent-events-list"', '</section>')).toContain(message);
  });
});
