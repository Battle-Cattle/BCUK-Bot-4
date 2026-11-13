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
    expect(html).toContain('<strong>1</strong> shared overlay connected');
    expect(html).toContain('/overlay/shared/settings/import/9');
  });

  it('uses the plural for several connected overlays and hides the import list when empty', async () => {
    const html = await render({ connectedCount: 3, ownVideos: [] });
    expect(html).toContain('shared overlays connected');
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
