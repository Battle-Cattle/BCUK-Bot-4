import { describe, expect, it } from 'vitest';
import ejs from 'ejs';
import path from 'path';

const NAV_PATH = path.join(__dirname, '../../views/partials/nav.ejs');

const renderNav = (user: Record<string, unknown> | null) => ejs.renderFile(NAV_PATH, { user, csrfToken: 'tok' });

const makeUser = (accessLevel: number, isOwner = false) => ({
  discordId: '123', discordName: 'Someone', accessLevel, isOwner, currentGuildId: null, guilds: [],
});

/** Strips every dropdown's contents (`nav-group-items`) so only top-level entries are left. */
function withoutDropdownItems(menu: string): string {
  return menu.replace(/<div class="nav-group-items">[\s\S]*?<\/div>/g, '');
}

/** The `.navbar-menu` part of the rendered nav (excluding `navbar-end`). */
function menuOf(html: string): string {
  return html.slice(html.indexOf('class="navbar-menu"'), html.indexOf('class="navbar-end"'));
}

/** The top-level menu entries (group labels and plain links) in render order, at any indentation. */
function topLevelLabels(html: string): string[] {
  const menu = withoutDropdownItems(menuOf(html));
  const labels: string[] = [];
  const re = /<button class="nav-group-label"[^>]*>([^<]+?)\s*<span|<a href="[^"]+" class="nav-item">([^<]+)<\/a>/g;
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

  it('puts Channel Points and Loyalty Points inside the Viewer Rewards dropdown', async () => {
    const html = await renderNav(makeUser(0));
    const menu = menuOf(html);
    const labelAt = menu.indexOf('Viewer Rewards');
    const itemsStart = menu.indexOf('<div class="nav-group-items">', labelAt);
    const dropdown = menu.slice(itemsStart, menu.indexOf('</div>', itemsStart));
    expect(dropdown).toContain('href="/channel-points"');
    expect(dropdown).toContain('href="/loyalty-points"');
    // Neither link may also sit at the top level, outside the dropdown.
    expect(withoutDropdownItems(menu)).not.toContain('href="/channel-points"');
    expect(withoutDropdownItems(menu)).not.toContain('href="/loyalty-points"');
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
