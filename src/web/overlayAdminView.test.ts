import { describe, it, expect } from 'vitest';
import path from 'path';
import ejs from 'ejs';

const viewPath = path.join(__dirname, '../../views/overlayAdmin.ejs');

function render(locals: Record<string, unknown> = {}): Promise<string> {
  return ejs.renderFile(viewPath, {
    user: { discordId: '1', discordName: 'Streamer', accessLevel: 0, isOwner: false, currentGuildId: null, guilds: [] },
    csrfToken: 'tok',
    streamer: { id: 7, twitch_name: 'Streamer' },
    videos: [{ id: 3, name: 'clip.webm', filename: 'abc.webm', created_at: new Date('2026-01-01T00:00:00Z') }],
    rewards: [],
    twitchRewards: [],
    baseUrl: 'https://bot.example',
    maxFileMb: 100,
    // A non-default limit, so a template that hardcoded 100 would fail these tests.
    maxVideoWeight: 42,
    error: null,
    success: null,
    ...locals,
  });
}

describe('views/overlayAdmin.ejs', () => {
  it('limits each video weight input to maxVideoWeight', async () => {
    const html = await render();
    expect(html).toContain('name="weight_3" value="1" min="1" max="42" step="1"');
  });

  it('names the maxVideoWeight range in the invalid_weight message', async () => {
    const html = await render({ error: 'invalid_weight' });
    expect(html).toContain('Each video weight must be a whole number from 1 to 42.');
  });
});
