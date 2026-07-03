import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { updateSfxFile, deleteSfxFile } from '../../db';
import { csrfProtection } from '../csrf';
import { requireMod } from '../middleware';
import { logAndRedirectError, parsePositiveIntId } from './shared';
import { removeSfxFiles, parseWeight } from './sfxMutationsShared';

const log = createLogger('Web');
const router = Router();

/**
 * POST /sfx/file/update — update a sound file's weight and hidden flag. Rejects a
 * missing/invalid id or weight with `invalid_id`/`invalid_weight`, surfaces a
 * stale id (no row updated) as `invalid_id`, and redirects `success=file_updated`
 * on success.
 * @param req Express request; reads `file_id`, `weight`, `file_hidden` from the body.
 * @param res Express response; always issues a redirect.
 */
router.post('/sfx/file/update', requireMod, csrfProtection, async (req, res) => {
  const fileId = parsePositiveIntId(req.body.file_id);
  if (fileId === null) return res.redirect('/sfx?error=invalid_id');

  const weight = parseWeight(req.body.weight);
  if (weight === null) return res.redirect('/sfx?error=invalid_weight');
  const hidden = req.body.file_hidden === 'on';

  try {
    const updated = await updateSfxFile(fileId, weight, hidden);
    if (!updated) return res.redirect('/sfx?error=invalid_id');
  } catch (err) {
    return logAndRedirectError({ res, log, logLabel: 'Update SFX file error:', err, basePath: '/sfx', errorCode: 'update_failed' });
  }

  res.redirect('/sfx?success=file_updated');
});

/**
 * POST /sfx/file/remove — delete a sound file row and its on-disk file. Rejects a
 * missing/invalid id with `invalid_id`, surfaces a stale id (no row deleted) as
 * `invalid_id`, and redirects `success=file_removed` on success.
 * @param req Express request; reads `file_id` from the body.
 * @param res Express response; always issues a redirect.
 */
router.post('/sfx/file/remove', requireMod, csrfProtection, async (req, res) => {
  const fileId = parsePositiveIntId(req.body.file_id);
  if (fileId === null) return res.redirect('/sfx?error=invalid_id');

  try {
    const file = await deleteSfxFile(fileId);
    if (file === null) return res.redirect('/sfx?error=invalid_id');
    await removeSfxFiles([file]);
  } catch (err) {
    return logAndRedirectError({ res, log, logLabel: 'Remove SFX file error:', err, basePath: '/sfx', errorCode: 'remove_failed' });
  }

  res.redirect('/sfx?success=file_removed');
});

export default router;
