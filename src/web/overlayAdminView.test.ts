import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
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
    publishedVideoIds: [],
    importedLibraryIds: [],
    isAdmin: false,
    baseUrl: 'https://bot.example',
    maxFileMb: 100,
    maxTotalMb: 1024,
    libraryMaxTotalMb: 10240,
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

describe('views/overlayAdmin.ejs library removal', () => {
  const ENTRY = {
    id: 4, name: 'Confetti', filename: 'lib.webm', contributor_streamer_id: 9,
    contributor_login: 'alice', source_video_id: 12, created_at: new Date('2026-11-01T00:00:00Z'),
  };

  it('renders a "Remove from library" form on each entry for an Admin', async () => {
    const html = await render({ libraryVideos: [ENTRY], isAdmin: true });
    expect(html).toContain('<form method="POST" action="/overlay/settings/library/4/remove" class="m-0 js-confirm-remove-library-video">');
    expect(html).toContain('Remove from library');
  });

  it('renders no removal form for anyone else', async () => {
    const html = await render({ libraryVideos: [ENTRY], isAdmin: false });
    expect(html).not.toContain('/overlay/settings/library/4/remove');
    expect(html).not.toContain('Remove from library');
  });

  it('explains the removal success and not_found messages', async () => {
    expect(await render({ success: 'library_video_removed' })).toContain('Video removed from the public library. Copies streamers already added are kept.');
    expect(await render({ error: 'not_found' })).toContain('That library video no longer exists.');
  });
});

describe('public/overlayAdmin.js', () => {
  /** Runs utils.js and overlayAdmin.js in a fake page and submits a form with `className`. */
  function submitForm(className: string, confirmResult: boolean) {
    class TestForm {
      classList = { contains: (name: string) => name === className };
    }
    const handlers: Array<(event: unknown) => void> = [];
    const confirm = vi.fn(() => confirmResult);
    const context = {
      HTMLFormElement: TestForm,
      window: { confirm },
      registerUploadFormHandler: vi.fn(),
      document: { addEventListener: (type: string, listener: (event: unknown) => void) => { if (type === 'submit') handlers.push(listener); } },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/utils.js'), 'utf8'), context);
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/overlayAdmin.js'), 'utf8'), context);
    const event = { target: new TestForm(), preventDefault: vi.fn() };
    handlers.forEach((h) => h(event));
    return { confirm, event };
  }

  it('confirms before an Admin removes a library video, saying imported copies are kept', () => {
    const { confirm, event } = submitForm('js-confirm-remove-library-video', false);
    expect(confirm).toHaveBeenCalledWith('Remove this video from the public library? Streamers who already added it to their own videos keep their copies.');
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('confirms before a streamer adds a video to the public library, saying only an Admin can remove it', () => {
    const { confirm, event } = submitForm('js-confirm-publish-video', false);
    expect(confirm).toHaveBeenCalledWith('Add this video to the public library? Every streamer will be able to see it and add it to their own videos, and only an Admin can remove it afterwards.');
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('lets the removal submit once confirmed', () => {
    const { confirm, event } = submitForm('js-confirm-remove-library-video', true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('still confirms video deletes with their own message', () => {
    const { confirm } = submitForm('js-confirm-delete-video', false);
    expect(confirm).toHaveBeenCalledWith('Delete this video? Any reward assignments using it will be removed.');
  });
});

describe('views/overlayAdmin.ejs publishing', () => {
  it('offers "Add to public library" on a video that is not in the library', async () => {
    const html = await render();
    expect(html).toContain('<form method="POST" action="/overlay/settings/videos/3/publish" class="m-0 js-confirm-publish-video">');
    expect(html).toContain('Add to public library');
    expect(html).not.toContain('In public library');
  });

  it('shows "In public library" instead once the video is in it', async () => {
    const html = await render({ publishedVideoIds: [3] });
    expect(html).toContain('In public library');
    expect(html).not.toContain('/overlay/settings/videos/3/publish');
  });

  it('explains the publish outcomes', async () => {
    expect(await render({ success: 'video_published' })).toContain('Video added to the public library. Every streamer can now see it and add it to their own videos.');
    expect(await render({ error: 'not_your_video' })).toContain('That video is not one of yours.');
    expect(await render({ error: 'already_in_library' })).toContain('That video is already in the public library.');
    expect(await render({ error: 'publish_failed' })).toContain('Adding the video to the public library failed — please try again.');
  });
});

describe('views/overlayAdmin.ejs importing', () => {
  const ENTRY = {
    id: 4, name: 'Confetti', filename: 'lib.webm', contributor_streamer_id: 9,
    contributor_login: 'alice', source_video_id: 12, created_at: new Date('2026-11-01T00:00:00Z'),
  };

  it('offers "Add to my videos" on a library entry the streamer has not imported', async () => {
    const html = await render({ libraryVideos: [ENTRY] });
    expect(html).toContain('<form method="POST" action="/overlay/settings/library/4/import" class="m-0">');
    expect(html).toContain('>Add to my videos</button>');
    expect(html).not.toContain('Already added');
  });

  it('marks an entry already imported, and still lets the streamer add another copy', async () => {
    const html = await render({ libraryVideos: [ENTRY], importedLibraryIds: [4] });
    expect(html).toContain('<span class="hint hint-compact">Already added</span>');
    expect(html).toContain('/overlay/settings/library/4/import');
    expect(html).toContain('>Add another copy</button>');
  });

  it('explains the import outcomes', async () => {
    expect(await render({ success: 'video_imported' })).toContain('Library video added to your videos. You can now assign it to rewards and advanced commands.');
    expect(await render({ error: 'import_failed' })).toContain('Adding the library video to your videos failed — please try again.');
  });

  it('explains the storage cap errors, naming the configured limits', async () => {
    expect(await render({ error: 'storage_limit', maxTotalMb: 2048 }))
      .toContain('That would take your videos over your 2048 MB storage limit. Delete some videos to make room.');
    expect(await render({ error: 'library_full', libraryMaxTotalMb: 4096 }))
      .toContain('The public library is full (4096 MB). An Admin needs to remove some videos before more can be added.');
  });

  it('tells the streamer their total storage limit next to the upload form', async () => {
    expect(await render({ maxTotalMb: 2048 })).toContain('2048 MB for all your videos together');
  });
});
