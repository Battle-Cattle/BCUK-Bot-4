import fs from 'fs';
import { Router } from 'express';
import { createLogger } from '../../shared/logger';
import { OVERLAY_FOLDER } from '../../shared/config';
import { csrfProtection } from '../csrf';
import { getSessionUser } from '../session';
import {
  removeSharedVideo, renameSharedVideo, setSharedVideoEnabled,
  getStreamerByDiscordId, getVideosForStreamer,
} from '../../db';
import { safeResolve, realPathWithin } from '../../shared/pathUtils';
import { parsePositiveIntId } from './validation';
import { logAndRedirectError } from './errorHandling';
import { storeSharedVideo, recordSharedVideo, removeSharedVideoFile } from './sharedOverlayVideoStorage';
import { broadcastSharedVideoList } from './sharedOverlaySource';
import { SHARED_SETTINGS_PATH } from './sharedOverlayAdminShared';

// Rename, enable/disable, delete and import for shared overlay videos (#917). Mounted by
// sharedOverlayAdmin.ts behind the Manager gate (requireAuth → requireGuildContext → requireManager).

const log = createLogger('SharedOverlayAdminMutations');
export const router = Router();

/**
 * Tells connected overlays the list changed. A failure is logged, not reported: the change itself
 * succeeded, and overlays pick the list up when they reconnect.
 * @returns Resolves once the broadcast was attempted; never rejects.
 */
async function broadcastListQuietly(): Promise<void> {
  try {
    await broadcastSharedVideoList();
  } catch (err) {
    log.error('Failed to broadcast shared video list:', err);
  }
}

/**
 * POST /overlay/shared/settings/:id/rename — renames a shared video.
 * @param req - Express request; reads the `id` route param and the `name` body field.
 * @param res - Redirects to the settings page with `?success=video_renamed`, or `?error=` `invalid_id`,
 *   `invalid_name` or `not_found` (or `save_failed` on an error).
 */
router.post('/:id/rename', csrfProtection, async (req, res) => {
  try {
    const id = parsePositiveIntId(req.params.id);
    if (id === null) return res.redirect(`${SHARED_SETTINGS_PATH}?error=invalid_id`);
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 100) : '';
    if (!name) return res.redirect(`${SHARED_SETTINGS_PATH}?error=invalid_name`);
    if (!await renameSharedVideo(id, name)) return res.redirect(`${SHARED_SETTINGS_PATH}?error=not_found`);
    await broadcastListQuietly();
    res.redirect(`${SHARED_SETTINGS_PATH}?success=video_renamed`);
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Shared video rename error:', err, basePath: SHARED_SETTINGS_PATH, errorCode: 'save_failed' });
  }
});

/**
 * POST /overlay/shared/settings/:id/enabled — enables or disables a shared video.
 * @param req - Express request; reads the `id` route param and the `enabled` body field (`1` or `0`).
 * @param res - Redirects with `?success=video_enabled`/`video_disabled`, or `?error=` `invalid_id`,
 *   `not_found` (or `save_failed` on an error).
 */
router.post('/:id/enabled', csrfProtection, async (req, res) => {
  try {
    const id = parsePositiveIntId(req.params.id);
    if (id === null) return res.redirect(`${SHARED_SETTINGS_PATH}?error=invalid_id`);
    const enabled = req.body?.enabled === '1';
    if (!await setSharedVideoEnabled(id, enabled)) return res.redirect(`${SHARED_SETTINGS_PATH}?error=not_found`);
    await broadcastListQuietly();
    res.redirect(`${SHARED_SETTINGS_PATH}?success=${enabled ? 'video_enabled' : 'video_disabled'}`);
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Shared video enable error:', err, basePath: SHARED_SETTINGS_PATH, errorCode: 'save_failed' });
  }
});

/**
 * POST /overlay/shared/settings/:id/delete — deletes a shared video: the row first, then the file,
 * so a failed file removal leaves a harmless orphan rather than a row with no file.
 * @param req - Express request; reads the `id` route param.
 * @param res - Redirects with `?success=video_deleted`, or `?error=` `invalid_id`, `not_found`
 *   or `delete_failed`.
 */
router.post('/:id/delete', csrfProtection, async (req, res) => {
  try {
    const id = parsePositiveIntId(req.params.id);
    if (id === null) return res.redirect(`${SHARED_SETTINGS_PATH}?error=invalid_id`);
    const filename = await removeSharedVideo(id);
    if (filename === null) return res.redirect(`${SHARED_SETTINGS_PATH}?error=not_found`);
    await removeSharedVideoFile(filename);
    await broadcastListQuietly();
    res.redirect(`${SHARED_SETTINGS_PATH}?success=video_deleted`);
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Shared video delete error:', err, basePath: SHARED_SETTINGS_PATH, errorCode: 'delete_failed' });
  }
});

/**
 * Converts the Manager's own overlay video into a new shared video, copying its file as the
 * conversion source so the original is untouched.
 * @param streamerId - DB row ID of the Manager's streamer record.
 * @param videoId - Primary key of their `overlay_video` row.
 * @param discordId - Discord snowflake of the Manager, recorded as the uploader.
 * @returns The redirect URL for the outcome.
 */
async function importOwnVideo(streamerId: number, videoId: number, discordId: string): Promise<string> {
  const video = (await getVideosForStreamer(streamerId)).find((v) => v.id === videoId);
  if (!video) return `${SHARED_SETTINGS_PATH}?error=not_found`;
  const lexical = safeResolve(OVERLAY_FOLDER, String(streamerId), video.filename);
  const real = lexical ? await realPathWithin(OVERLAY_FOLDER, lexical) : null;
  if (!real) return `${SHARED_SETTINGS_PATH}?error=not_found`;
  const filename = await storeSharedVideo((dest) => fs.promises.copyFile(real, dest, fs.constants.COPYFILE_EXCL));
  await recordSharedVideo(video.name, filename, discordId);
  await broadcastListQuietly();
  log.info(`Manager ${discordId} added overlay video ${videoId} to the shared list as ${filename}`);
  return `${SHARED_SETTINGS_PATH}?success=video_added`;
}

/**
 * POST /overlay/shared/settings/import/:videoId — one-off "Add to shared list" for one of the
 * Manager's own overlay videos. Chosen over an owner-only script or a library action because the
 * Manager already sees their videos and no extra tooling is needed; the video is always converted
 * to WebM (even if it already is one) so there is a single code path.
 * @param req - Express request; reads the `videoId` route param and the session user.
 * @param res - Redirects with `?success=video_added`, or `?error=` `invalid_id`, `not_a_streamer`,
 *   `not_found`, `transcode_busy`, `transcode_failed` or `save_failed`.
 */
router.post('/import/:videoId', csrfProtection, async (req, res) => {
  try {
    const videoId = parsePositiveIntId(req.params.videoId);
    if (videoId === null) return res.redirect(`${SHARED_SETTINGS_PATH}?error=invalid_id`);
    const { discordId } = getSessionUser(req);
    const streamer = await getStreamerByDiscordId(discordId);
    if (!streamer) return res.redirect(`${SHARED_SETTINGS_PATH}?error=not_a_streamer`);
    res.redirect(await importOwnVideo(streamer.id, videoId, discordId));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'transcode_busy' || code === 'transcode_failed') return res.redirect(`${SHARED_SETTINGS_PATH}?error=${code}`);
    logAndRedirectError({ res, log, logLabel: 'Shared video import error:', err, basePath: SHARED_SETTINGS_PATH, errorCode: 'save_failed' });
  }
});
