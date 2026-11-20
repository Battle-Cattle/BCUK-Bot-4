import { describe, expect, it } from 'vitest';
import ejs from 'ejs';
import path from 'path';
// The shared test mirror of AccessLevel's values, used so this view test doesn't load the DB layer (which needs DISCORD_TOKEN).
// Note: accessLevelMock.test.ts pins the mirror's values but doesn't compare them with src/db/users.ts.
import { ACCESS_LEVEL_MOCK as AccessLevel } from '../test-utils/accessLevelMock';

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

/** A nav entry: a top-level link `[href, label]`, or a dropdown group with its links in order. */
type NavEntry = [string, string] | { group: string; items: [string, string][] };

const LINK_RE = /<a href="([^"]+)" class="nav-item">([^<]+)<\/a>/g;

/** Every link `[href, label]` in `html`, in order. */
function linksIn(html: string): [string, string][] {
  return [...html.matchAll(LINK_RE)].map((m) => [m[1]!, m[2]!.trim()]);
}

/**
 * The whole `.navbar-menu` in render order: plain links, and each dropdown group with every link inside it.
 * The group alternative is tried first, so a link inside a dropdown is only ever counted inside its group.
 */
function menuEntries(html: string): NavEntry[] {
  const re = /<button class="nav-group-label"[^>]*>([^<]+?)\s*<span[\s\S]*?<div class="nav-group-items">([\s\S]*?)<\/div>|<a href="([^"]+)" class="nav-item">([^<]+)<\/a>/g;
  return [...menuOf(html).matchAll(re)].map((m) =>
    m[1] ? { group: m[1].trim(), items: linksIn(m[2]!) } : [m[3]!, m[4]!.trim()],
  );
}

const BOT_COMMANDS_SIGNED_IN: [string, string][] = [
  ['/sfx', 'SFX'], ['/commands', 'Commands'], ['/timers', 'Timers'], ['/advanced-commands', 'Advanced Commands'],
];
const DEVICES: NavEntry = { group: 'Devices', items: [['/streamdeck-key', 'Streamdeck Key'], ['/companion-key', 'Companion App']] };
const VIEWER_REWARDS: NavEntry = { group: 'Viewer Rewards', items: [['/channel-points', 'Channel Points'], ['/loyalty-points', 'Loyalty Points']] };
const OVERLAYS_BELOW_MANAGER: NavEntry = {
  group: 'Overlays',
  items: [['/overlay/settings', 'Video'], ['/alerts/settings', 'Alerts'], ['/overlay/controller/settings', 'Controller']],
};
const OVERLAYS_MANAGER_UP: NavEntry = {
  group: 'Overlays',
  items: [['/overlay/settings', 'Video'], ['/overlay/shared/settings', 'Shared Video'], ['/alerts/settings', 'Alerts'], ['/overlay/controller/settings', 'Controller']],
};

/** The full menu for a signed-in user below Manager (access levels 0 and 1 see the same entries). */
const BELOW_MANAGER_MENU: NavEntry[] = [
  ['/', 'Dashboard'],
  { group: 'Bot Commands', items: BOT_COMMANDS_SIGNED_IN },
  OVERLAYS_BELOW_MANAGER,
  VIEWER_REWARDS,
  DEVICES,
  ['/user/settings', 'Settings'],
];

/** The full menu for Manager and up, given the Admin group's links. */
const managerUpMenu = (adminItems: [string, string][]): NavEntry[] => [
  ['/', 'Dashboard'],
  { group: 'Bot Commands', items: [...BOT_COMMANDS_SIGNED_IN, ['/counters', 'Counters']] },
  OVERLAYS_MANAGER_UP,
  VIEWER_REWARDS,
  DEVICES,
  ['/user/settings', 'Settings'],
  { group: 'Admin', items: adminItems },
];

describe('views/partials/nav.ejs entries for every access level', () => {
  // Locks today's nav so the responsive rework (#1080: #1109, #1119, #1121) can't silently add, drop, reorder or
  // regate an entry: any change to these lists has to be deliberate.
  it.each([
    ['signed out', null, [
      ['/', 'Dashboard'],
      { group: 'Bot Commands', items: [['/sfx', 'SFX']] },
      DEVICES,
    ]],
    ['a User (0)', makeUser(AccessLevel.USER), BELOW_MANAGER_MENU],
    ['a Mod (1)', makeUser(AccessLevel.MOD), BELOW_MANAGER_MENU],
    ['a Manager (2)', makeUser(AccessLevel.MANAGER), managerUpMenu([['/admin/streams', 'Streams'], ['/admin/users', 'Users']])],
    ['an Admin (3), not owner', makeUser(AccessLevel.ADMIN), managerUpMenu([
      ['/admin/streams', 'Streams'], ['/admin/users', 'Users'], ['/admin/streamdeck-keys', 'Streamdeck Keys'],
    ])],
    ['the owner (Admin, 3)', makeUser(AccessLevel.ADMIN, true), managerUpMenu([
      ['/admin/streams', 'Streams'], ['/admin/users', 'Users'], ['/admin/streamdeck-keys', 'Streamdeck Keys'], ['/admin/health', 'Health'],
    ])],
  ] as [string, Record<string, unknown> | null, NavEntry[]][])('lists every entry, in order, for %s', async (_who, user, expected) => {
    expect(menuEntries(await renderNav(user))).toEqual(expected);
  });

  it('keeps the brand link home and the toggle wired to the collapsible menu', async () => {
    const html = await renderNav(makeUser(AccessLevel.USER));

    expect(html).toContain('<a href="/" class="navbar-brand">');
    expect(html).toContain('<button class="navbar-toggle" aria-label="Toggle navigation" aria-expanded="false" aria-controls="navbar-collapse">');
    expect(html).toContain('<div class="navbar-collapse" id="navbar-collapse" aria-hidden="false">');
    expect(html.match(/<button class="nav-group-label" aria-haspopup="true" aria-expanded="false">/g)).toHaveLength(4);
    expect(html).toContain('<script src="/navbar.js"></script>');
  });
});

/** The `.navbar-end` part of the rendered nav. */
function endOf(html: string): string {
  return html.slice(html.indexOf('class="navbar-end"'), html.indexOf('</nav>'));
}

describe('views/partials/nav.ejs navbar end', () => {
  const guild = (id: string, name: string) => ({ guildId: id, name });

  it('offers a server switcher with several guilds, naming the current one', async () => {
    const user = { ...makeUser(AccessLevel.USER), guilds: [guild('1', 'Alpha'), guild('2', 'Beta')], currentGuildId: '2' };

    expect(endOf(await renderNav(user))).toContain('<a href="/guild/select" class="nav-item guild-switcher" title="Switch server">🏠 Beta ▾</a>');
  });

  it('asks to choose a server when several guilds and none current', async () => {
    const user = { ...makeUser(AccessLevel.USER), guilds: [guild('1', 'Alpha'), guild('2', 'Beta')], currentGuildId: null };

    expect(endOf(await renderNav(user))).toContain('🏠 Choose server ▾</a>');
  });

  it('shows the single guild as plain text, not a switcher', async () => {
    const end = endOf(await renderNav({ ...makeUser(AccessLevel.USER), guilds: [guild('1', 'Alpha')], currentGuildId: '1' }));

    expect(end).toContain('<span class="guild-name">🏠 Alpha</span>');
    expect(end).not.toContain('guild-switcher');
  });

  it('shows no guild when the only guild is not the current one', async () => {
    const end = endOf(await renderNav({ ...makeUser(AccessLevel.USER), guilds: [guild('1', 'Alpha')], currentGuildId: '9' }));

    expect(end).not.toContain('guild-name');
    expect(end).not.toContain('guild-switcher');
  });

  it('shows no guild at all with no guilds', async () => {
    const end = endOf(await renderNav(makeUser(AccessLevel.USER)));

    expect(end).not.toContain('guild-name');
    expect(end).not.toContain('guild-switcher');
  });

  it.each([
    [AccessLevel.USER, 'User'], [AccessLevel.MOD, 'Mod'], [AccessLevel.MANAGER, 'Manager'], [AccessLevel.ADMIN, 'Admin'],
  ])('badges access level %i as %s', async (level, label) => {
    expect(endOf(await renderNav(makeUser(level)))).toContain(`<span class="badge level-${level}">${label}</span>`);
  });

  it('badges an access level outside 0-3 as Unknown', async () => {
    expect(endOf(await renderNav(makeUser(7)))).toContain('<span class="badge level-7">Unknown</span>');
  });

  it("shows the signed-in user's name", async () => {
    expect(endOf(await renderNav(makeUser(AccessLevel.USER)))).toContain('<span class="username">Someone</span>');
  });

  it('shows the avatar only when the user has one', async () => {
    const withAvatar = endOf(await renderNav({ ...makeUser(AccessLevel.USER), discordAvatar: 'https://cdn.discordapp.com/a.png' }));

    expect(withAvatar).toContain('<img src="https://cdn.discordapp.com/a.png?size=32" class="avatar" alt="">');
    expect(endOf(await renderNav(makeUser(AccessLevel.USER)))).not.toContain('class="avatar"');
  });

  it('logs out with a CSRF-protected POST form', async () => {
    const end = endOf(await renderNav(makeUser(AccessLevel.USER)));

    expect(end).toContain('<form method="POST" action="/auth/logout" class="d-inline m-0">');
    expect(end).toContain('<input type="hidden" name="_csrf" value="tok">');
    expect(end).toContain('<button type="submit" class="btn btn-ghost btn-sm">Logout</button>');
  });

  it('shows no user details or logout when signed out', async () => {
    const end = endOf(await renderNav(null));

    expect(end).not.toContain('/auth/logout');
    expect(end).not.toContain('class="username"');
    expect(end).not.toContain('class="badge');
  });
});
