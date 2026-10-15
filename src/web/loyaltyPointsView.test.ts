import { describe, it, expect } from 'vitest';
import path from 'path';
import ejs from 'ejs';

const viewPath = path.join(__dirname, '../../views/loyaltyPoints.ejs');

function render(locals: Record<string, unknown>): Promise<string> {
  return ejs.renderFile(viewPath, {
    user: { discordId: '1', discordName: 'Streamer', accessLevel: 0, isOwner: false, currentGuildId: null, guilds: [] },
    csrfToken: 'tok',
    isStreamer: true,
    prerequisites: { twitchLinked: true, chatBotEnabled: true, isMonitoredStreamer: true },
    allPrerequisitesMet: true,
    leaderboard: [],
    excludedUsers: [],
    config: { enabled: true, pointsPerMessage: 1, cooldownSeconds: 60, pointsPerSub: 100, pointsPerGiftSub: 100 },
    error: null,
    ...locals,
  });
}

describe('views/loyaltyPoints.ejs', () => {
  it('shows an "Exclude bot" button for each leaderboard entry, posting that viewer', async () => {
    const html = await render({ leaderboard: [{ twitchUsername: 'pokemoncommunitygame', balance: 900 }, { twitchUsername: 'viewer1', balance: 50 }] });
    expect(html).toContain('action="/loyalty-points/exclusions"');
    expect(html.match(/>Exclude bot</g)).toHaveLength(2);
    expect(html).toContain('name="twitch_username" value="pokemoncommunitygame"');
    expect(html).toContain('name="twitch_username" value="viewer1"');
  });

  it('asks for confirmation before excluding, naming the account', async () => {
    const html = await render({ leaderboard: [{ twitchUsername: 'pokemoncommunitygame', balance: 900 }] });
    expect(html).toContain('class="js-confirm-exclude-bot" data-twitch-username="pokemoncommunitygame"');
    expect(html).toContain('<script src="/utils.js"></script>');
    expect(html).toContain('<script src="/loyaltyPoints.js"></script>');
  });

  it('lists excluded bots with a "Remove exclusion" button', async () => {
    const html = await render({ excludedUsers: ['bcuk_bot'] });
    expect(html).toContain('action="/loyalty-points/exclusions/remove"');
    expect(html).toContain('name="twitch_username" value="bcuk_bot"');
    expect(html).toContain('Remove exclusion');
    expect(html).not.toContain('No bots are excluded.');
  });

  it('says so when no bots are excluded', async () => {
    const html = await render({});
    expect(html).toContain('No bots are excluded.');
    expect(html).not.toContain('action="/loyalty-points/exclusions/remove"');
  });

  it('shows a readable message for the exclusion error codes', async () => {
    expect(await render({ error: 'invalid_username' })).toContain('That isn&#39;t a valid Twitch username.');
    expect(await render({ error: 'exclusion_failed' })).toContain('Failed to update the excluded bots');
  });

  it('hides the excluded bots card from a signed-in user with no streamer record', async () => {
    const html = await render({ isStreamer: false });
    expect(html).not.toContain('Excluded Bots');
  });
});
