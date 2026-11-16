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

  /** The links inside the Overlays dropdown. */
  const overlaysDropdown = (html: string): string => {
    const menu = menuOf(html);
    const itemsStart = menu.indexOf('<div class="nav-group-items">', menu.indexOf('Overlays'));
    return menu.slice(itemsStart, menu.indexOf('</div>', itemsStart));
  };

  it('lists Shared Video in the Overlays dropdown for a Manager, after Video', async () => {
    const dropdown = overlaysDropdown(await renderNav(makeUser(2)));
    expect(dropdown).toContain('<a href="/overlay/shared/settings" class="nav-item">Shared Video</a>');
    expect(dropdown.indexOf('href="/overlay/shared/settings"')).toBeGreaterThan(dropdown.indexOf('href="/overlay/settings"'));
    expect(dropdown.indexOf('href="/overlay/shared/settings"')).toBeLessThan(dropdown.indexOf('href="/alerts/settings"'));
  });

  it('does not list Shared Video below Manager, as the page is closed to them', async () => {
    for (const level of [0, 1]) {
      const html = await renderNav(makeUser(level));
      expect(overlaysDropdown(html)).not.toContain('/overlay/shared/settings');
      expect(overlaysDropdown(html)).toContain('href="/overlay/settings"');
    }
  });

  it('shows no Overlays menu, so no Shared Video link, when signed out', async () => {
    expect(await renderNav(null)).not.toContain('/overlay/shared/settings');
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
