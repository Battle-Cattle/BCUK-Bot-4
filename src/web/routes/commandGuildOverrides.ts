import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { upsertOverride, removeOverride } from '../../db';
import { csrfProtection } from '../csrf';
import { requireMod, requireGuildContext } from '../middleware';
import { parsePositiveIntId } from './shared';

const log = createLogger('Web');
const router = Router();

/**
 * Sets or updates the per-guild override for a catalog command.
 * Accepts `command_id`, `is_disabled` ("1" = disabled, absent = enabled),
 * `output` (custom output text) and `clear_output` ("1" = remove any custom output).
 * Guild ID is always taken from the session — never from the request body.
 */
router.post('/commands/guild-override', requireMod, requireGuildContext, csrfProtection, async (req, res) => {
  const guildId = req.session.user!.currentGuildId!;
  const body = req.body as Record<string, string | undefined>;
  const commandId = parsePositiveIntId(body.command_id);
  if (!commandId) return res.redirect('/commands?error=invalid_id');

  const isDisabled = body.is_disabled === '1';
  const clearOutput = body.clear_output === '1';
  const rawOutput = (body.output ?? '').trim();
  const output = clearOutput || !rawOutput ? null : rawOutput;

  try {
    await upsertOverride(guildId, commandId, { isDisabled, output });
    res.redirect('/commands');
  } catch (err) {
    log.error('Guild command override upsert failed:', err);
    res.redirect('/commands?error=override_failed');
  }
});

/**
 * Removes the per-guild override for a catalog command, reverting it to the catalog default.
 * Accepts `command_id`. Guild ID is always taken from the session.
 */
router.post('/commands/guild-override/reset', requireMod, requireGuildContext, csrfProtection, async (req, res) => {
  const guildId = req.session.user!.currentGuildId!;
  const body = req.body as Record<string, string | undefined>;
  const commandId = parsePositiveIntId(body.command_id);
  if (!commandId) return res.redirect('/commands?error=invalid_id');

  try {
    await removeOverride(guildId, commandId);
    res.redirect('/commands');
  } catch (err) {
    log.error('Guild command override reset failed:', err);
    res.redirect('/commands?error=override_reset_failed');
  }
});

export default router;
