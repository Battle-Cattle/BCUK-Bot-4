import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { csrfProtection } from '../csrf';
import { requireAuth, requireGuildContext, requireAdmin } from '../middleware';
import { getSessionUser } from '../session';
import { addVideoToLibrary, getVideosForStreamer, removeLibraryVideo, type AddVideoToLibraryResult } from '../../db';
import { libraryPublishLimiter } from '../rateLimits';
import { parsePositiveIntId } from './validation';
import { logAndRedirectError } from './errorHandling';
import { removeLibraryVideoFile, withLinkedVideoFile, LIBRARY_FOLDER, streamerFolder } from './overlayVideoLibraryFiles';
import { requireStreamer } from './viewHelpers';
import { NOT_A_STREAMER_REDIRECT } from './overlayAdminShared';

// Public overlay video library mutations (#907), mounted from overlayAdmin.ts next to the video
// and reward mutation routers. Publishing (5/6) and importing (6/6) add their routes here.

const log = createLogger('OverlayAdminLibrary');
export const router = Router();

/**
 * POST /overlay/settings/library/:id/remove — Admin only: removes an entry from the public video
 * library, deleting its row and then its library file (row first, as video delete does, so a
 * failed file removal leaves a harmless orphan file rather than a row with no file). Copies
 * streamers already imported are their own `overlay_video` rows and files, and are kept.
 * `requireGuildContext` runs before `requireAdmin`, so the Admin check uses the access level
 * re-derived for the current guild rather than the session's cached one.
 * @param req - Express request; reads the `id` route param and the session user.
 * @param res - Express response; redirects to `/overlay/settings?success=library_video_removed`,
 *   or to `/overlay/settings?error=<code>` for a malformed id (`invalid_id`), an entry that no
 *   longer exists (`not_found`) or a failed delete (`delete_failed`). Non-Admins get a 403.
 */
router.post('/settings/library/:id/remove', requireAuth, requireGuildContext, requireAdmin, csrfProtection, async (req, res) => {
  try {
    const libraryId = parsePositiveIntId(req.params.id);
    if (libraryId === null) return res.redirect('/overlay/settings?error=invalid_id');

    const filename = await removeLibraryVideo(libraryId);
    if (filename === null) return res.redirect('/overlay/settings?error=not_found');

    log.info(`Admin ${getSessionUser(req).discordId} removed library video ${libraryId} (${filename})`);
    await removeLibraryVideoFile(filename);
    res.redirect('/overlay/settings?success=library_video_removed');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Overlay library remove error:', err, basePath: '/overlay/settings', errorCode: 'delete_failed' });
  }
});

/** Redirect for each `addVideoToLibrary` outcome. */
const PUBLISH_REDIRECTS: Record<AddVideoToLibraryResult['status'], string> = {
  added: '/overlay/settings?success=video_published',
  not_owner: '/overlay/settings?error=not_your_video',
  already_in_library: '/overlay/settings?error=already_in_library',
};

/**
 * Adds one of the streamer's own videos to the public library: links its file into the library
 * folder under a new name (a hard link, or a copy across filesystems), then records the entry with
 * `addVideoToLibrary`, which re-checks ownership in its transaction. The new library file is
 * removed again unless the entry was added (another streamer's video, one already in the library,
 * or a DB failure), so no file is left without its row.
 * @param videoId - Primary key of the streamer's `overlay_video` row.
 * @param streamerId - DB row ID of the publishing streamer.
 * @returns The redirect URL for the outcome.
 */
async function publishVideo(videoId: number, streamerId: number): Promise<string> {
  const video = (await getVideosForStreamer(streamerId)).find((v) => v.id === videoId);
  if (!video) return PUBLISH_REDIRECTS.not_owner;

  const linked = await withLinkedVideoFile(
    { folder: streamerFolder(streamerId), filename: video.filename },
    LIBRARY_FOLDER,
    async (libraryFilename) => {
      const result = await addVideoToLibrary(videoId, streamerId, libraryFilename);
      return { keepFile: result.status === 'added', result };
    },
  );
  if (linked.status === 'source_missing') {
    log.error(`Overlay video ${videoId} of streamer ${streamerId} has no file to publish (${video.filename})`);
    return '/overlay/settings?error=publish_failed';
  }
  if (linked.result.status === 'added') {
    log.info(`Streamer ${streamerId} added video ${videoId} to the public library as entry ${linked.result.libraryId}`);
  }
  return PUBLISH_REDIRECTS[linked.result.status];
}

/**
 * POST /overlay/settings/videos/:id/publish — adds one of the requesting streamer's videos to the
 * public library, where every streamer can see and import it and only an Admin can remove it.
 * Rate-limited per account by `libraryPublishLimiter`.
 * @param req - Express request; reads the `id` route param and the session user.
 * @param res - Express response; redirects to `/overlay/settings?success=video_published`, or to
 *   `/overlay/settings?error=<code>` if the requester isn't a streamer (`not_a_streamer`), `id` is
 *   malformed (`invalid_id`), the video isn't theirs (`not_your_video`), it's already in the
 *   library (`already_in_library`) or publishing fails (`publish_failed`). Over the rate limit,
 *   replies 429.
 */
router.post('/settings/videos/:id/publish', requireAuth, libraryPublishLimiter, csrfProtection, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res, NOT_A_STREAMER_REDIRECT);
    if (!streamer) return;

    const videoId = parsePositiveIntId(req.params.id);
    if (videoId === null) return res.redirect('/overlay/settings?error=invalid_id');

    res.redirect(await publishVideo(videoId, streamer.id));
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Overlay library publish error:', err, basePath: '/overlay/settings', errorCode: 'publish_failed' });
  }
});
