import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import {
  findTrigger,
  createSfxTrigger,
  updateSfxTrigger,
  deleteSfxTrigger,
  isMysqlDuplicateEntryError,
} from '../../db';
import { csrfProtection } from '../csrf';
import { requireMod } from '../middleware';
import {
  normalizeRequiredText,
  normalizeSingleTokenRequiredText,
  parsePositiveIntId,
} from './shared';
import { removeSfxFiles } from './sfxMutationsShared';

const log = createLogger('Web');
const router = Router();

/** Parse an optional category id form field. Empty/"none" → null; invalid → null. */
function parseCategoryId(value: unknown): number | null {
  if (typeof value !== 'string' || value === '' || value === 'none') return null;
  return parsePositiveIntId(value);
}

router.post('/sfx/trigger/add', requireMod, csrfProtection, async (req, res) => {
  const command = normalizeSingleTokenRequiredText(req.body.trigger_command);
  if (!command) return res.redirect('/sfx?error=missing_fields');

  const categoryId = parseCategoryId(req.body.category_id);
  const description = normalizeRequiredText(req.body.description);
  const hidden = req.body.hidden === 'on';

  try {
    if (await findTrigger(command)) return res.redirect('/sfx?error=command_taken');
    await createSfxTrigger(command, categoryId, description, hidden);
  } catch (err) {
    if (isMysqlDuplicateEntryError(err)) return res.redirect('/sfx?error=command_taken');
    log.error('Add SFX trigger error:', err);
    return res.redirect('/sfx?error=add_failed');
  }

  res.redirect('/sfx?success=trigger_added');
});

router.post('/sfx/trigger/update', requireMod, csrfProtection, async (req, res) => {
  const triggerId = parsePositiveIntId(req.body.trigger_id);
  const command = normalizeSingleTokenRequiredText(req.body.trigger_command);
  if (!command) return res.redirect('/sfx?error=missing_fields');
  if (triggerId === null) return res.redirect('/sfx?error=invalid_id');

  const categoryId = parseCategoryId(req.body.category_id);
  const description = normalizeRequiredText(req.body.description);
  const hidden = req.body.hidden === 'on';

  try {
    const existing = await findTrigger(command);
    if (existing && existing.id !== BigInt(triggerId)) {
      return res.redirect('/sfx?error=command_taken');
    }
    await updateSfxTrigger(BigInt(triggerId), command, categoryId, description, hidden);
  } catch (err) {
    if (isMysqlDuplicateEntryError(err)) return res.redirect('/sfx?error=command_taken');
    log.error('Update SFX trigger error:', err);
    return res.redirect('/sfx?error=update_failed');
  }

  res.redirect('/sfx?success=trigger_updated');
});

router.post('/sfx/trigger/remove', requireMod, csrfProtection, async (req, res) => {
  const triggerId = parsePositiveIntId(req.body.trigger_id);
  if (triggerId === null) return res.redirect('/sfx?error=invalid_id');

  try {
    const { files } = await deleteSfxTrigger(BigInt(triggerId));
    await removeSfxFiles(files);
  } catch (err) {
    log.error('Remove SFX trigger error:', err);
    return res.redirect('/sfx?error=remove_failed');
  }

  res.redirect('/sfx?success=trigger_removed');
});

export default router;
