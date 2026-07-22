import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { getAllSfxTriggers, getAllCategories, AccessLevel } from '../../db';
import { csrfProtection } from '../csrf';
import { SFX_MAX_FILE_MB, OPENAI_API_KEY } from '../../shared/config';
import { filterQueryParam, renderError, renderView } from './shared';

const log = createLogger('Web');
const router = Router();

const KNOWN_ERRORS = new Set([
  'missing_fields',
  'invalid_id',
  'invalid_file',
  'invalid_path',
  'invalid_weight',
  'file_too_large',
  'command_taken',
  'add_failed',
  'update_failed',
  'remove_failed',
  'upload_failed',
]);

const KNOWN_SUCCESS = new Set([
  'trigger_added',
  'trigger_updated',
  'trigger_removed',
  'file_uploaded',
  'file_updated',
  'file_removed',
  'category_added',
  'category_updated',
  'category_removed',
]);

/**
 * Render the SFX page with all triggers and categories. Visible to any logged-in
 * user; management controls are only rendered for Mod+ (canManage), matching the
 * server-side requireMod guard on every mutation route. The "Suggest description"
 * button (canSuggestDescriptions) is further restricted to the bot owner while that
 * feature is being trialled, and hidden entirely when OPENAI_API_KEY isn't set,
 * matching the server-side requireOwner guard on its route.
 */
router.get('/sfx', csrfProtection, async (req, res) => {
  try {
    const [triggers, categories] = await Promise.all([getAllSfxTriggers(), getAllCategories()]);
    const canManage = (req.session.user?.accessLevel ?? 0) >= AccessLevel.MOD;
    const canSuggestDescriptions = !!req.session.user?.isOwner && OPENAI_API_KEY !== '';
    renderView(res, 'sfx', {
      user: req.session.user,
      triggers,
      categories,
      canManage,
      canSuggestDescriptions,
      maxUploadMb: SFX_MAX_FILE_MB,
      csrfToken: req.csrfToken(),
      error: filterQueryParam(req.query.error, KNOWN_ERRORS),
      success: filterQueryParam(req.query.success, KNOWN_SUCCESS),
    });
  } catch (err) {
    log.error('SFX error:', err);
    renderError(res, 500, 'Failed to load SFX data.', req.session.user);
  }
});

export default router;
