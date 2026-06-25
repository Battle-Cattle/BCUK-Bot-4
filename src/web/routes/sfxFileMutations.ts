import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { updateSfxFile, deleteSfxFile } from '../../db';
import { csrfProtection } from '../csrf';
import { requireMod } from '../middleware';
import { parsePositiveIntId } from './shared';
import { removeSfxFiles, parseWeight } from './sfxMutationsShared';

const log = createLogger('Web');
const router = Router();

router.post('/sfx/file/update', requireMod, csrfProtection, async (req, res) => {
  const fileId = parsePositiveIntId(req.body.file_id);
  if (fileId === null) return res.redirect('/sfx?error=invalid_id');

  const weight = parseWeight(req.body.weight);
  if (weight === null) return res.redirect('/sfx?error=invalid_weight');
  const hidden = req.body.file_hidden === 'on';

  try {
    await updateSfxFile(fileId, weight, hidden);
  } catch (err) {
    log.error('Update SFX file error:', err);
    return res.redirect('/sfx?error=update_failed');
  }

  res.redirect('/sfx?success=file_updated');
});

router.post('/sfx/file/remove', requireMod, csrfProtection, async (req, res) => {
  const fileId = parsePositiveIntId(req.body.file_id);
  if (fileId === null) return res.redirect('/sfx?error=invalid_id');

  try {
    const file = await deleteSfxFile(fileId);
    if (file) await removeSfxFiles([file]);
  } catch (err) {
    log.error('Remove SFX file error:', err);
    return res.redirect('/sfx?error=remove_failed');
  }

  res.redirect('/sfx?success=file_removed');
});

export default router;
