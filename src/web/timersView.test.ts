import { describe, it, expect } from 'vitest';
import path from 'path';
import ejs from 'ejs';

const viewPath = path.join(__dirname, '../../views/timers.ejs');

const STREAMER_ID = '111111111111111111';

function timer(overrides: Record<string, unknown> = {}): any {
  return {
    id: 1,
    name: 'Discord plug',
    message: 'Join our Discord!',
    interval_seconds: 600,
    min_messages: 0,
    require_live: true,
    enabled: true,
    assigned_users: [{ discord_id: STREAMER_ID, discord_name: 'Streamer', twitch_name: 'streamer', is_orphaned_user: false }],
    unassigned_users: [{ discord_id: '333333333333333333', discord_name: 'Other', twitch_name: 'other' }],
    canEdit: true,
    ...overrides,
  };
}

function render(locals: Record<string, unknown>): Promise<string> {
  return ejs.renderFile(viewPath, {
    user: { discordId: STREAMER_ID, discordName: 'Streamer', accessLevel: 0, isOwner: false, currentGuildId: '900000000000000001', guilds: [] },
    timers: [],
    assignableUsers: [],
    canManageCatalog: false,
    twitchLinked: true,
    csrfToken: 'tok',
    error: null,
    ...locals,
  });
}

describe('views/timers.ejs', () => {
  it('lets a streamer add, edit, toggle and remove their own timer, without the assignment controls', async () => {
    const html = await render({ timers: [timer()] });
    expect(html).toContain('action="/timers/add"');
    expect(html).toContain('action="/timers/update"');
    expect(html).toContain('action="/timers/toggle"');
    expect(html).toContain('action="/timers/remove"');
    expect(html).not.toContain('action="/timers/assign"');
    expect(html).not.toContain('name="discord_ids"');
    expect(html).not.toContain('Remove from my channel');
  });

  it('offers a streamer only "Remove from my channel" on a timer they cannot edit', async () => {
    const html = await render({ timers: [timer({ canEdit: false })] });
    expect(html).toContain('Remove from my channel');
    expect(html).toContain('action="/timers/unassign"');
    expect(html).toContain(`name="discord_id" value="${STREAMER_ID}"`);
    expect(html).not.toContain('action="/timers/update"');
    expect(html).not.toContain('action="/timers/toggle"');
    expect(html).not.toContain('action="/timers/remove"');
  });

  it('asks a streamer without a linked Twitch account to link one instead of showing the add form', async () => {
    const html = await render({ twitchLinked: false });
    expect(html).toContain('href="/user/settings"');
    expect(html).not.toContain('action="/timers/add"');
    expect(html).toContain('Your channel has no timers yet.');
  });

  it('shows the full controls to a Mod', async () => {
    const assignable = [{ discord_id: '333333333333333333', discord_name: 'Other', twitch_name: 'other' }];
    const html = await render({
      canManageCatalog: true,
      user: { discordId: '2', discordName: 'Mod', accessLevel: 1, isOwner: false, currentGuildId: '900000000000000001', guilds: [] },
      timers: [timer()],
      assignableUsers: assignable,
    });
    expect(html).toContain('name="discord_ids"');
    expect(html).toContain('action="/timers/assign"');
    expect(html).toContain('action="/timers/update"');
    expect(html).not.toContain('Remove from my channel');
  });
});
