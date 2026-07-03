import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { createCategory, renameCategory, deleteCategory } from '../../db';
import { csrfProtection } from '../csrf';
import { requireMod } from '../middleware';
import { logAndRedirectError, normalizeRequiredText, parsePositiveIntId } from './shared';

const log = createLogger('Web');
const router = Router();

/** Create a new SFX category from the `name` form field, then redirect back to `/sfx`. */
router.post('/sfx/category/add', requireMod, csrfProtection, async (req, res) => {
  const name = normalizeRequiredText(req.body.name);
  if (!name) return res.redirect('/sfx?error=missing_fields');

  try {
    await createCategory(name);
  } catch (err) {
    return logAndRedirectError(res, log, 'Add SFX category error:', err, '/sfx', 'add_failed');
  }

  res.redirect('/sfx?success=category_added');
});

/** Rename the SFX category identified by `category_id` to the `name` form field, then redirect back to `/sfx`. */
router.post('/sfx/category/rename', requireMod, csrfProtection, async (req, res) => {
  const id = parsePositiveIntId(req.body.category_id);
  const name = normalizeRequiredText(req.body.name);
  if (id === null) return res.redirect('/sfx?error=invalid_id');
  if (!name) return res.redirect('/sfx?error=missing_fields');

  try {
    const renamed = await renameCategory(id, name);
    if (!renamed) return res.redirect('/sfx?error=invalid_id');
  } catch (err) {
    return logAndRedirectError(res, log, 'Rename SFX category error:', err, '/sfx', 'update_failed');
  }

  res.redirect('/sfx?success=category_updated');
});

/** Delete the SFX category identified by `category_id`, then redirect back to `/sfx`. */
router.post('/sfx/category/remove', requireMod, csrfProtection, async (req, res) => {
  const id = parsePositiveIntId(req.body.category_id);
  if (id === null) return res.redirect('/sfx?error=invalid_id');

  try {
    const removed = await deleteCategory(id);
    if (!removed) return res.redirect('/sfx?error=invalid_id');
  } catch (err) {
    return logAndRedirectError(res, log, 'Remove SFX category error:', err, '/sfx', 'remove_failed');
  }

  res.redirect('/sfx?success=category_removed');
});

export default router;
