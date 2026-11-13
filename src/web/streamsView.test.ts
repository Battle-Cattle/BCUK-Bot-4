import { describe, it, expect } from 'vitest';
import path from 'path';
import ejs from 'ejs';

const viewPath = path.join(__dirname, '../../views/streams.ejs');

/** Renders the Streams page with two streamers in one group. */
function render(locals: Record<string, unknown> = {}): Promise<string> {
  return ejs.renderFile(viewPath, {
    user: { discordId: '1', discordName: 'A', accessLevel: 3, isOwner: false, currentGuildId: null, guilds: [] },
    csrfToken: 'tok',
    groups: [],
    streamers: [
      { id: 42, discord_id: '10', twitch_name: 'connected_one', discord_name: null, group_id: 1, group_name: 'G' },
      { id: 43, discord_id: '11', twitch_name: 'not_connected', discord_name: null, group_id: 1, group_name: 'G' },
    ],
    isAdmin: true,
    eventSubConnectedById: { 42: true, 43: false },
    eligibleUsers: [],
    error: null,
    success: null,
    getFriendlyError: (key: string) => key,
    ...locals,
  });
}

describe('streams view — EventSub badge', () => {
  it('shows the connected badge and Disconnect for a connected streamer, and the not-connected badge otherwise', async () => {
    const html = await render();
    expect(html.match(/title="EventSub connected"/g)).toHaveLength(1);
    expect(html.match(/title="EventSub not connected"/g)).toHaveLength(1);
    expect(html).toContain('/admin/streams/twitch-disconnect/42');
    expect(html).not.toContain('/admin/streams/twitch-disconnect/43');
  });

  it('shows no badge for a streamer without the Twitch bot enabled, or to a non-admin', async () => {
    const withoutRow = await render({ eventSubConnectedById: { 42: true } });
    expect(withoutRow.match(/title="EventSub/g)).toHaveLength(1);

    const asManager = await render({ isAdmin: false });
    expect(asManager).not.toContain('title="EventSub');
    expect(asManager).not.toContain('twitch-disconnect');
  });
});
