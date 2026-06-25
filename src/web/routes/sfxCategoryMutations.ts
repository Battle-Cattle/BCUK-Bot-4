import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { createCategory, renameCategory, deleteCategory } from '../../db';
import { csrfProtection } from '../csrf';
import { requireMod } from '../middleware';
import { normalizeRequiredText, parsePositiveIntId } from './shared';

const log = createLogger('Web');
const router = Router();

router.post('/sfx/category/add', requireMod, csrfProtection, async (req, res) => {
  const name = normalizeRequiredText(req.body.name);
  if (!name) return res.redirect('/sfx?error=missing_fields');

  try {
    await createCategory(name);
  } catch (err) {
    log.error('Add SFX category error:', err);
    return res.redirect('/sfx?error=add_failed');
  }

  res.redirect('/sfx?success=category_added');
});

router.post('/sfx/category/rename', requireMod, csrfProtection, async (req, res) => {
  const id = parsePositiveIntId(req.body.category_id);
  const name = normalizeRequiredText(req.body.name);
  if (id === null) return res.redirect('/sfx?error=invalid_id');
  if (!name) return res.redirect('/sfx?error=missing_fields');

  try {
    await renameCategory(id, name);
  } catch (err) {
    log.error('Rename SFX category error:', err);
    return res.redirect('/sfx?error=update_failed');
  }

  res.redirect('/sfx?success=category_updated');
});

router.post('/sfx/category/remove', requireMod, csrfProtection, async (req, res) => {
  const id = parsePositiveIntId(req.body.category_id);
  if (id === null) return res.redirect('/sfx?error=invalid_id');

  try {
    await deleteCategory(id);
  } catch (err) {
    log.error('Remove SFX category error:', err);
    return res.redirect('/sfx?error=remove_failed');
  }

  res.redirect('/sfx?success=category_removed');
});

export default router;
