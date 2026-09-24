import { describe, it, expect } from 'vitest';
import path from 'path';
import ejs from 'ejs';

const viewPath = path.join(__dirname, '../../views/commands.ejs');

const STREAMER_ID = '111111111111111111';

function command(overrides: Record<string, unknown> = {}): any {
  return {
    command_id: 1,
    trigger_string: '!mine',
    output: 'mine',
    is_discord_enabled: false,
    is_multi_twitch: false,
    assigned_users: [{ discord_id: STREAMER_ID, discord_name: 'Streamer', twitch_name: 'streamer', is_orphaned_user: false }],
    unassigned_users: [],
    guildOverride: null,
    canEdit: true,
    ...overrides,
  };
}

function render(locals: Record<string, unknown>): Promise<string> {
  return ejs.renderFile(viewPath, {
    user: { discordId: STREAMER_ID, discordName: 'Streamer', accessLevel: 0, isOwner: false, currentGuildId: '900000000000000001', guilds: [] },
    commands: [],
    assignableUsers: [],
    canManageCatalog: false,
    twitchLinked: true,
    csrfToken: 'tok',
    error: null,
    ...locals,
  });
}

describe('views/commands.ejs', () => {
  it('hides catalog-only controls from a streamer', async () => {
    const html = await render({ commands: [command()] });
    expect(html).toContain('action="/commands/add"');
    expect(html).toContain('action="/commands/update"');
    expect(html).not.toContain('name="is_discord_enabled"');
    expect(html).not.toContain('name="is_multi_twitch"');
    expect(html).not.toContain('action="/commands/assign"');
    expect(html).not.toContain('action="/commands/guild-override"');
  });

  it('offers a streamer only "Remove from my channel" on a command they cannot edit', async () => {
    const html = await render({ commands: [command({ canEdit: false })] });
    expect(html).toContain('Remove from my channel');
    expect(html).toContain(`name="discord_id" value="${STREAMER_ID}"`);
    expect(html).not.toContain('action="/commands/update"');
    expect(html).not.toContain('action="/commands/remove"');
  });

  it('asks a streamer without a linked Twitch account to link one instead of showing the add form', async () => {
    const html = await render({ twitchLinked: false });
    expect(html).toContain('href="/user/settings"');
    expect(html).not.toContain('action="/commands/add"');
  });

  it('shows the full controls to a Mod', async () => {
    const html = await render({
      canManageCatalog: true,
      user: { discordId: '2', discordName: 'Mod', accessLevel: 1, isOwner: false, currentGuildId: '900000000000000001', guilds: [] },
      commands: [command()],
    });
    expect(html).toContain('name="is_discord_enabled"');
    expect(html).toContain('name="is_multi_twitch"');
    expect(html).toContain('action="/commands/guild-override"');
    expect(html).not.toContain('Remove from my channel');
  });
});

describe('views/partials/nav.ejs', () => {
  it('shows the Commands link to a plain user but keeps Counters/Timers at Manager+', async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../../views/partials/nav.ejs'), {
      user: { discordId: STREAMER_ID, discordName: 'Streamer', accessLevel: 0, isOwner: false, currentGuildId: null, guilds: [] },
      csrfToken: 'tok',
    });
    expect(html).toContain('href="/commands"');
    expect(html).not.toContain('href="/counters"');
    expect(html).not.toContain('href="/timers"');
  });
});
