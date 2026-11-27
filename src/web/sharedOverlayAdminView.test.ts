import { describe, it, expect } from 'vitest';
import path from 'path';
import ejs from 'ejs';

const viewPath = path.join(__dirname, '../../views/sharedOverlayAdmin.ejs');

/** Renders the page with one enabled and one disabled video. */
function render(locals: Record<string, unknown> = {}): Promise<string> {
  return ejs.renderFile(viewPath, {
    user: { discordId: '1', discordName: 'M', accessLevel: 2, isOwner: false, currentGuildId: null, guilds: [] },
    csrfToken: 'tok',
    videos: [
      { id: 1, name: 'Clap', filename: 'a.webm', enabled: true, uploader_login: 'bob', created_at: new Date(0) },
      { id: 2, name: 'Boo', filename: 'b.webm', enabled: false, uploader_login: null, created_at: new Date(0) },
    ],
    ownVideos: [{ id: 9, name: 'Mine' }],
    connectedCount: 1,
    pushedCount: 0,
    baseUrl: 'https://bot.example',
    streamer: { id: 5 },
    maxFileMb: 100,
    error: null,
    success: null,
    ...locals,
  });
}

describe('sharedOverlayAdmin view', () => {
  it('lists the videos with enable/disable and delete controls and the connected count', async () => {
    const html = await render();
    expect(html).toContain('/overlay/shared/settings/1/rename');
    expect(html).toContain('Disable');
    expect(html).toContain('Enable');
    expect(html).toContain('/overlay/shared/settings/2/delete');
    expect(html).toMatch(/id="readiness-summary"[^>]*>Loading…</);
    expect(html).toContain('/overlay/shared/settings/import/9');
  });

  it('has no separate Readiness card; readiness lives in the connection card and the video table', async () => {
    const html = await render();
    expect(html).not.toContain('Per video');
    expect(html).not.toContain('id="readiness-videos"');
    expect(html).toContain('id="readiness-status"');
    expect(html.match(/self-reported/g)).toHaveLength(1);
    expect(html).toContain('<th>Readiness</th>');
    expect(html).toContain('data-readiness-video="1">Loading…');
    expect(html).toContain('data-readiness-push="1"');
    expect(html.match(/Clap/g)).toHaveLength(1);
  });

  it('shows no readiness cell for a disabled video', async () => {
    const html = await render();
    expect(html).not.toContain('data-readiness-video="2"');
    expect(html).not.toContain('data-readiness-push="2"');
    expect(html).toMatch(/Disabled<\/td>\s*<td>—<\/td>/);
  });

  it('shows no video table when there are no videos, and hides the import list when empty', async () => {
    const html = await render({ videos: [], ownVideos: [] });
    expect(html).toContain('No shared videos yet.');
    expect(html).not.toContain('data-readiness-video');
    expect(html).not.toContain('Add one of your overlay videos');
  });

  it('says how many overlays a push reached, singular and plural', async () => {
    expect(await render({ success: 'video_pushed', pushedCount: 1 })).toContain('Pushed to 1 connected overlay.');
    expect(await render({ success: 'video_pushed', pushedCount: 4 })).toContain('Pushed to 4 connected overlays.');
  });

  it('shows error and success messages', async () => {
    expect(await render({ error: 'transcode_failed' })).toContain('could not be converted');
    expect(await render({ success: 'video_deleted' })).toContain('Video deleted.');
    expect(await render({ error: 'push_cooldown' })).toContain('pushed a moment ago');
    expect(await render({ error: 'video_disabled' })).toContain('Enable it before pushing');
  });
});
