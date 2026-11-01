import { describe, expect, it } from 'vitest';
import ejs from 'ejs';
import path from 'path';

const NAV_PATH = path.join(__dirname, '../../views/partials/nav.ejs');

const renderNav = (user: Record<string, unknown> | null) => ejs.renderFile(NAV_PATH, { user, csrfToken: 'tok' });

const makeUser = (accessLevel: number, isOwner = false) => ({
  discordId: '123', discordName: 'Someone', accessLevel, isOwner, currentGuildId: null, guilds: [],
});

/** The top-level menu entries (group labels and plain links) in render order, from the `.navbar-menu` only. */
function topLevelLabels(html: string): string[] {
  const menu = html.slice(html.indexOf('class="navbar-menu"'), html.indexOf('class="navbar-end"'));
  const labels: string[] = [];
  const re = /<button class="nav-group-label"[^>]*>([^<]+?)\s*<span|^ {6}<a href="[^"]+" class="nav-item">([^<]+)<\/a>/gm;
  for (const m of menu.matchAll(re)) labels.push((m[1] ?? m[2])!.trim());
  return labels;
}

describe('views/partials/nav.ejs ordering', () => {
  it('orders the menu day-to-day first, then setup, then Admin last for an admin', async () => {
    const html = await renderNav(makeUser(3, true));
    expect(topLevelLabels(html)).toEqual([
      'Dashboard', 'Bot Commands', 'Overlays', 'Viewer Rewards', 'Devices', 'Settings', 'Admin',
    ]);
  });

  it('groups Channel Points and Loyalty Points under Viewer Rewards', async () => {
    const html = await renderNav(makeUser(0));
    const groupStart = html.indexOf('Viewer Rewards');
    const groupEnd = html.indexOf('Devices');
    const group = html.slice(groupStart, groupEnd);
    expect(group).toContain('href="/channel-points"');
    expect(group).toContain('href="/loyalty-points"');
  });

  it('ends with Settings and shows no Admin menu for a plain user', async () => {
    const html = await renderNav(makeUser(0));
    expect(topLevelLabels(html)).toEqual([
      'Dashboard', 'Bot Commands', 'Overlays', 'Viewer Rewards', 'Devices', 'Settings',
    ]);
    expect(html).not.toContain('href="/admin/');
  });

  it('shows only Dashboard, Bot Commands (SFX) and Devices when logged out', async () => {
    const html = await renderNav(null);
    expect(topLevelLabels(html)).toEqual(['Dashboard', 'Bot Commands', 'Devices']);
    expect(html).toContain('href="/sfx"');
    expect(html).not.toContain('href="/commands"');
    expect(html).not.toContain('href="/channel-points"');
    expect(html).not.toContain('href="/user/settings"');
  });
});
