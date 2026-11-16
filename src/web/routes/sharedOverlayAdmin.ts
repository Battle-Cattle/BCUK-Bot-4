import { Router } from 'express';
import { createLogger } from '../../shared/logger';
import { OVERLAY_MAX_FILE_MB, PUBLIC_URL } from '../../shared/config';
import { csrfProtection } from '../csrf';
import { requireAuth, requireGuildContext, requireManager } from '../middleware';
import { getSessionUser } from '../session';
import { getStreamerByDiscordId, getVideosForStreamer, listSharedVideos } from '../../db';
import { CHUNKED_UPLOAD_ERROR_CODES } from './chunkedUploadRoutes';
import { filterQueryParam } from './validation';
import { renderError, renderView } from './viewHelpers';
import { parseUploadId, getConversionProgress } from './overlayConversionProgress';
import { getSharedOverlayConnectionCount } from './sharedOverlaySource';
import { SHARED_PROGRESS_KEY } from './sharedOverlayAdminShared';
import { router as mutationsRouter } from './sharedOverlayAdminMutations';
import { router as uploadRouter } from './sharedOverlayAdminUpload';
import { router as pushRouter } from './sharedOverlayAdminPush';
import { router as readinessRouter } from './sharedOverlayReadinessStream';

// The Manager+ settings page of the shared video overlay (#917), mounted at /overlay/shared/settings.
// `settings` is a reserved login, so this path can't collide with a streamer's shared overlay.

const log = createLogger('SharedOverlayAdmin');
const router = Router();

const KNOWN_ERRORS = new Set([
  'invalid_id', 'invalid_name', 'not_found', 'not_a_streamer', 'invalid_file', 'upload_failed',
  'delete_failed', 'save_failed', 'transcode_failed', 'transcode_busy', 'video_disabled', 'push_cooldown',
  ...CHUNKED_UPLOAD_ERROR_CODES,
]);
const KNOWN_SUCCESSES = new Set([
  'video_uploaded', 'video_renamed', 'video_enabled', 'video_disabled', 'video_deleted', 'video_added', 'video_pushed',
]);

// requireGuildContext re-derives the access level for the current guild; it must run before
// requireManager, which reads that level.
router.use(requireAuth, requireGuildContext, requireManager);

/**
 * Reads the `pushed` count the push redirect carries.
 * @param raw - The untrusted query value.
 * @returns A whole number from 0 to 9999 (plenty for a handful of overlays), or 0 if it is not one.
 */
function parsePushedCount(raw: unknown): number {
  return typeof raw === 'string' && /^\d{1,4}$/.test(raw) ? Number(raw) : 0;
}

/**
 * GET /overlay/shared/settings — renders the shared videos page: the list with its controls, the
 * upload form, the number of connected shared overlays, and the Manager's own overlay videos to
 * add to the list.
 * @param req - Express request; reads the session user and the `error`/`success` query params.
 * @param res - Express response; renders `sharedOverlayAdmin`, or a 500 page on failure.
 */
router.get('/', csrfProtection, async (req, res) => {
  try {
    const streamer = await getStreamerByDiscordId(getSessionUser(req).discordId);
    const [videos, ownVideos] = await Promise.all([
      listSharedVideos(),
      streamer ? getVideosForStreamer(streamer.id) : Promise.resolve([]),
    ]);
    renderView(res, 'sharedOverlayAdmin', {
      user: req.session.user,
      csrfToken: req.csrfToken(),
      videos,
      ownVideos,
      connectedCount: getSharedOverlayConnectionCount(),
      pushedCount: parsePushedCount(req.query.pushed),
      baseUrl: PUBLIC_URL,
      streamer: streamer ?? null,
      maxFileMb: OVERLAY_MAX_FILE_MB,
      error: filterQueryParam(req.query.error, KNOWN_ERRORS),
      success: filterQueryParam(req.query.success, KNOWN_SUCCESSES),
    });
  } catch (err) {
    log.error('Shared overlay settings page error:', err);
    renderError(res, 500, 'Failed to load shared overlay settings.', req.session.user);
  }
});

/**
 * GET /overlay/shared/settings/progress/:uploadId — how far an upload's conversion has got, polled
 * by the page while the upload request is still running.
 * @param req - Express request; reads the `uploadId` route param.
 * @param res - JSON `{ stage, percent }`; `stage` is `none` for an unknown or finished upload.
 */
router.get('/progress/:uploadId', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const uploadId = parseUploadId(req.params.uploadId);
  res.json((uploadId && getConversionProgress(SHARED_PROGRESS_KEY, uploadId)) ?? { stage: 'none', percent: null });
});

router.use(readinessRouter);
router.use(pushRouter);
router.use(uploadRouter);
router.use(mutationsRouter);

export default router;
