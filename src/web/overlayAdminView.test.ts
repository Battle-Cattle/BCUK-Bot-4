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
    libraryVideos: [],
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

describe('views/overlayAdmin.ejs upload progress', () => {
  it('gives the upload form a hidden progress display and the conversion progress endpoint', async () => {
    const html = await render();
    expect(html).toMatch(/class="js-overlay-upload"\s+data-progress-url="\/overlay\/settings\/videos\/progress" data-processing-label="Saving…"/);
    expect(html).toContain('<div class="upload-progress is-hidden mt-04" data-upload-progress>');
    expect(html).toContain('<progress class="upload-progress-bar" max="100" value="0" aria-label="Upload progress"></progress>');
    expect(html).toContain('data-upload-progress-label role="status" aria-live="polite"');
  });
});

describe('views/overlayAdmin.ejs public library', () => {
  const ENTRY = {
    id: 4, name: 'Confetti <b>', filename: 'lib.webm', contributor_streamer_id: 9,
    contributor_login: 'alice', source_video_id: 12, created_at: new Date('2026-11-01T00:00:00Z'),
  };

  it('shows the empty state when the library has no videos', async () => {
    const html = await render();
    expect(html).toContain('<h2 class="section-title">Public library</h2>');
    expect(html).toContain('No videos in the library yet.');
  });

  it('lists each entry with its name, contributor, date and a lazy preview', async () => {
    const html = await render({ libraryVideos: [ENTRY] });
    expect(html).not.toContain('No videos in the library yet.');
    expect(html).toContain('<td>Confetti &lt;b&gt;</td>');
    expect(html).toContain('<td>alice</td>');
    expect(html).toContain(`<td>${ENTRY.created_at.toLocaleDateString()}</td>`);
    expect(html).toContain('<video class="library-preview" src="/overlay/library/videos/lib.webm" preload="metadata" controls muted playsinline></video>');
  });

  it('shows "unknown" when the contributor is gone', async () => {
    const html = await render({ libraryVideos: [{ ...ENTRY, contributor_streamer_id: null, contributor_login: null }] });
    expect(html).toContain('<td>unknown</td>');
  });
});
