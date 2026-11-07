import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { csrfProtection } from '../csrf';
import { requireAuth, requireGuildContext, requireAdmin } from '../middleware';
import { getSessionUser } from '../session';
import { removeLibraryVideo } from '../../db';
import { parsePositiveIntId } from './validation';
import { logAndRedirectError } from './errorHandling';
import { removeLibraryVideoFile } from './overlayVideoLibraryFiles';

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
