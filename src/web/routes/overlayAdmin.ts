import path from 'path';
import { createLogger } from '../../shared/logger';
import { Router, type Response } from 'express';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { getSessionUser } from '../session';
import { AccessLevel, getStreamerByDiscordId } from '../../db';
import { getVideosForStreamer, getRewardsForStreamer, getLibraryVideos } from '../../db';
import { PUBLIC_URL, OVERLAY_FOLDER, OVERLAY_STATUS_MAX_SSE_PER_STREAMER } from '../../shared/config';
import { fetchStreamerRewards } from './streamerRewards';
import { filterQueryParam } from './validation';
import { renderError, renderView } from './viewHelpers';
import { router as mutationsRouter, MAX_UPLOAD_MB } from './overlayAdminMutations';
import { router as rewardMutationsRouter } from './overlayAdminRewardMutations';
import { router as libraryMutationsRouter } from './overlayAdminLibraryMutations';
import { MAX_OVERLAY_VIDEO_WEIGHT } from './overlayAdminShared';
import { connections as overlaySourceConnections } from './overlaySource';
import { createOverlayStatusEventsHandler } from './sseEventsHandlers';
import { parseUploadId, getConversionProgress } from './overlayConversionProgress';
import { CHUNKED_UPLOAD_ERROR_CODES } from './chunkedUploadRoutes';
import { LIBRARY_FOLDER } from './overlayVideoLibraryFiles';
import { resolveSharedFile, sendStreamerFile } from './streamerFileServing';

const log = createLogger('OverlayAdmin');
const router = Router();

// How often the settings-page SSE stream re-checks whether the overlay browser source is open.

// In-memory map of active `/settings/events` SSE connections, keyed by streamer ID.
export const statusConnections = new Map<number, Set<Response>>();

const KNOWN_ERRORS = new Set([
  'not_a_streamer', 'invalid_file', 'upload_failed', 'delete_failed',
  'invalid_reward_id', 'no_videos_selected', 'save_failed', 'invalid_id', 'invalid_path',
  'file_too_large', 'invalid_weight', 'transcode_failed', 'transcode_busy', 'not_found',
  'not_your_video', 'already_in_library', 'publish_failed',
  ...CHUNKED_UPLOAD_ERROR_CODES,
]);
// Library files are copies of overlay videos, so they have the same names: a UUID plus .webm/.mp4.
const LIBRARY_FILENAME_RE = /^[\w-]+\.(webm|mp4)$/i;
// POSIX join, like safeResolve (which streamerFileServing uses on it) and the bot's Linux target.
const LIBRARY_DIR = path.posix.join(OVERLAY_FOLDER, LIBRARY_FOLDER);

const KNOWN_SUCCESSES = new Set([
  'video_uploaded', 'video_deleted', 'reward_saved', 'reward_deleted', 'library_video_removed', 'video_published',
]);

/**
 * Picks out which of a streamer's videos are already in the public library, for the "In public
 * library" label in place of the "Add to public library" button.
 * @param videos - The streamer's own overlay videos.
 * @param libraryVideos - Every public library entry, each with the video it was added from.
 * @returns Ids of the streamer's videos that are some library entry's `source_video_id`.
 */
function publishedVideoIdsOf(
  videos: ReadonlyArray<{ id: number }>,
  libraryVideos: ReadonlyArray<{ source_video_id: number | null }>,
): number[] {
  const sources = new Set(libraryVideos.map((entry) => entry.source_video_id));
  return videos.filter((v) => sources.has(v.id)).map((v) => v.id);
}

/**
 * GET /overlay/settings — renders the overlay settings page with the user's
 * uploaded videos, configured rewards, live Twitch custom rewards and the public
 * video library (if the user is a streamer).
 * @param req - Express request; reads `req.session.user`, `error`, and
 *   `success` query params.
 * @param res - Express response; renders the `overlayAdmin` view, or a 500
 *   error page if loading settings fails.
 */
router.get('/settings', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await getStreamerByDiscordId(getSessionUser(req).discordId);
    const [videos, rewards, twitchRewards, libraryVideos] = streamer
      ? await Promise.all([
          getVideosForStreamer(streamer.id),
          getRewardsForStreamer(streamer.id),
          fetchStreamerRewards(streamer, log),
          getLibraryVideos(),
        ])
      : [[], [], [], []];

    renderView(res, 'overlayAdmin', {
      user: req.session.user,
      csrfToken: req.csrfToken(),
      streamer: streamer ?? null,
      videos,
      rewards,
      twitchRewards,
      libraryVideos,
      publishedVideoIds: publishedVideoIdsOf(videos, libraryVideos),
      // Only decides whether the page shows Admin controls. The session's cached level can be
      // stale (no requireGuildContext on this page); the remove route re-derives it before
      // requireAdmin, so a stale value can only show or hide a button, never grant access.
      isAdmin: (req.session.user?.accessLevel ?? AccessLevel.USER) >= AccessLevel.ADMIN,
      baseUrl: PUBLIC_URL,
      maxFileMb: MAX_UPLOAD_MB,
      maxVideoWeight: MAX_OVERLAY_VIDEO_WEIGHT,
      error:   filterQueryParam(req.query.error,   KNOWN_ERRORS),
      success: filterQueryParam(req.query.success, KNOWN_SUCCESSES),
    });
  } catch (err) {
    log.error('Overlay settings page error:', err);
    renderError(res, 500, 'Failed to load overlay settings.', req.session.user);
  }
});

/**
 * GET /overlay/settings/videos/progress/:uploadId — reports how far the requesting streamer's MOV
 * upload with that ID has got converting, for the settings page to show while the upload request
 * is still running. Polled every couple of seconds, so it never caches and never errors loudly.
 * @param req - Express request; reads the `uploadId` route param and the session user.
 * @param res - Express response; JSON `{ stage, percent }`, where `stage` is `queued`,
 *   `converting`, or `none` when the streamer has no conversion running under that ID (an
 *   unknown or malformed ID, a WebM/MP4 upload, a non-streamer, or a conversion already done).
 */
router.get('/settings/videos/progress/:uploadId', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const none = { stage: 'none', percent: null };
  try {
    const uploadId = parseUploadId(req.params.uploadId);
    if (!uploadId) return res.json(none);
    const streamer = await getStreamerByDiscordId(getSessionUser(req).discordId);
    res.json((streamer && getConversionProgress(streamer.id, uploadId)) ?? none);
  } catch (err) {
    log.error('Overlay conversion progress error:', err);
    res.status(500).json(none);
  }
});

/**
 * GET /overlay/library/videos/:filename — serves a public video library file for the settings
 * page's previews (Range requests included, via `sendFile`). Signed-in users only; playback on a
 * stream always uses the streamer's own imported copy under `/overlay/videos/...`. Can't clash
 * with the unauthenticated `/overlay/...` routes in `overlaySource.ts`: `/:login` and
 * `/:login/events` are one and two segments long, and `/videos/:streamerId/...` needs a numeric id.
 * @param req - Express request; reads the `filename` route param.
 * @param res - Express response; sends the file, or replies 400 if `filename` is malformed or
 *   unsafe, or 404 if the file doesn't exist or its real path is outside the library folder.
 */
router.get('/library/videos/:filename', requireAuth, async (req, res) => {
  const file = await resolveSharedFile(res, LIBRARY_DIR, String(req.params.filename), LIBRARY_FILENAME_RE);
  if (file) sendStreamerFile(res, file.realPath);
});

/**
 * GET /overlay/controller/settings — renders the controller overlay info page
 * (the OBS browser-source URL and setup notes for the gamepad overlay).
 * @param req - Express request; reads `req.session.user`.
 * @param res - Express response; renders the `controllerAdmin` view.
 */
router.get('/controller/settings', requireAuth, csrfProtection, (req, res) => {
  renderView(res, 'controllerAdmin', {
    user: req.session.user,
    csrfToken: req.csrfToken(),
    baseUrl: PUBLIC_URL,
  });
});

/**
 * GET /overlay/settings/events — SSE endpoint streaming `{ connected: boolean }` snapshots of
 * whether the logged-in user's own reward-video browser source currently has an open connection,
 * so the settings page can show a live status dot instead of the user only finding out something's
 * wrong when a reward video never plays. Connection lifecycle and status-push logic (streamer
 * resolution, SSE handshake, broadcast-on-change, and subscription cleanup) is shared with
 * the alerts overlay via `createOverlayStatusEventsHandler`.
 * @param req - Express request; reads `req.session.user`.
 * @param res - Express response; upgrades to a `text/event-stream` connection kept alive with
 *   periodic pings and torn down (including its overlay-connection subscription) on client disconnect;
 *   replies 403 if the user isn't a monitored streamer with a linked Twitch channel, 500 (logged)
 *   if the streamer lookup fails, or 429 if the connection limit is exceeded.
 */
router.get('/settings/events', requireAuth, createOverlayStatusEventsHandler({
  statusConnections,
  overlayConnections: overlaySourceConnections,
  maxPerChannel: OVERLAY_STATUS_MAX_SSE_PER_STREAMER,
  log,
}));

router.use(mutationsRouter);
router.use(rewardMutationsRouter);
router.use(libraryMutationsRouter);

export default router;
