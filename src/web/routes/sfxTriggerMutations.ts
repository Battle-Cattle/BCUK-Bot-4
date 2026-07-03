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
  logAndRedirectError,
  normalizeRequiredText,
  normalizeSingleTokenRequiredText,
  parsePositiveIntId,
  parsePositiveBigIntId,
} from './shared';
import { removeSfxFiles } from './sfxMutationsShared';

const log = createLogger('Web');
const router = Router();

/**
 * Parse an optional category id form field. An unset value — the field being
 * absent (undefined), empty, or "none" — maps to null. A present-but-malformed
 * value, including a non-string such as a repeated/tampered field arriving as an
 * array, maps to undefined so callers can reject it with `invalid_id` rather than
 * silently clearing the trigger's category.
 * @param value Raw `category_id` form field.
 * @returns null for an unset value, a positive id, or undefined when malformed.
 */
function parseCategoryId(value: unknown): number | null | undefined {
  if (value === undefined || value === '' || value === 'none') return null;
  if (typeof value !== 'string') return undefined;
  const parsed = parsePositiveIntId(value);
  return parsed === null ? undefined : parsed;
}

/** Create a new SFX trigger from the form fields (command, category, description, hidden), then redirect back to `/sfx`. */
router.post('/sfx/trigger/add', requireMod, csrfProtection, async (req, res) => {
  const command = normalizeSingleTokenRequiredText(req.body.trigger_command);
  if (!command) return res.redirect('/sfx?error=missing_fields');

  const categoryId = parseCategoryId(req.body.category_id);
  if (categoryId === undefined) return res.redirect('/sfx?error=invalid_id');
  const description = normalizeRequiredText(req.body.description);
  const hidden = req.body.hidden === 'on';

  try {
    if (await findTrigger(command)) return res.redirect('/sfx?error=command_taken');
    await createSfxTrigger(command, categoryId, description, hidden);
  } catch (err) {
    if (isMysqlDuplicateEntryError(err)) return res.redirect('/sfx?error=command_taken');
    return logAndRedirectError(res, log, 'Add SFX trigger error:', err, '/sfx', 'add_failed');
  }

  res.redirect('/sfx?success=trigger_added');
});

/** Update the SFX trigger identified by `trigger_id` with the submitted form fields, then redirect back to `/sfx`. */
router.post('/sfx/trigger/update', requireMod, csrfProtection, async (req, res) => {
  const triggerId = parsePositiveBigIntId(req.body.trigger_id);
  const command = normalizeSingleTokenRequiredText(req.body.trigger_command);
  if (!command) return res.redirect('/sfx?error=missing_fields');
  if (triggerId === null) return res.redirect('/sfx?error=invalid_id');

  const categoryId = parseCategoryId(req.body.category_id);
  if (categoryId === undefined) return res.redirect('/sfx?error=invalid_id');
  const description = normalizeRequiredText(req.body.description);
  const hidden = req.body.hidden === 'on';

  try {
    const existing = await findTrigger(command);
    if (existing && existing.id !== triggerId) {
      return res.redirect('/sfx?error=command_taken');
    }
    const updated = await updateSfxTrigger(triggerId, command, categoryId, description, hidden);
    if (!updated) return res.redirect('/sfx?error=invalid_id');
  } catch (err) {
    if (isMysqlDuplicateEntryError(err)) return res.redirect('/sfx?error=command_taken');
    return logAndRedirectError(res, log, 'Update SFX trigger error:', err, '/sfx', 'update_failed');
  }

  res.redirect('/sfx?success=trigger_updated');
});

/** Delete the SFX trigger identified by `trigger_id` and its sound files (DB rows and disk files), then redirect back to `/sfx`. */
router.post('/sfx/trigger/remove', requireMod, csrfProtection, async (req, res) => {
  const triggerId = parsePositiveBigIntId(req.body.trigger_id);
  if (triggerId === null) return res.redirect('/sfx?error=invalid_id');

  try {
    const result = await deleteSfxTrigger(triggerId);
    if (result === null) return res.redirect('/sfx?error=invalid_id');
    await removeSfxFiles(result.files);
  } catch (err) {
    return logAndRedirectError(res, log, 'Remove SFX trigger error:', err, '/sfx', 'remove_failed');
  }

  res.redirect('/sfx?success=trigger_removed');
});

export default router;
