import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { upsertOverride, removeOverride } from '../../db';
import { csrfProtection } from '../csrf';
import { requireMod, requireGuildContext } from '../middleware';
import { getSessionUser } from '../session';
import { logAndRedirectError, parsePositiveIntId, trimField } from './shared';

const log = createLogger('Web');
const router = Router();

/**
 * Sets or updates the per-guild override for a catalog command.
 * Accepts `command_id`, `is_disabled` ("1" = disabled, absent = enabled),
 * `output` (custom output text) and `clear_output` ("1" = remove any custom output).
 * Guild ID is always taken from the session — never from the request body.
 * If the resulting state is equivalent to the catalog default (not disabled,
 * no custom output), the override row is removed instead of upserted.
 */
router.post('/commands/guild-override', requireGuildContext, requireMod, csrfProtection, async (req, res) => {
  const guildId = getSessionUser(req).currentGuildId!;
  const body = req.body as Record<string, unknown>;
  const commandId = parsePositiveIntId(body.command_id as string | string[] | undefined);
  if (!commandId) return res.redirect('/commands?error=invalid_id');

  const isDisabled = body.is_disabled === '1';
  const clearOutput = body.clear_output === '1';
  const rawOutput = trimField(Array.isArray(body.output) ? (body.output as string[])[0] : body.output as string | undefined);
  const output = clearOutput || !rawOutput ? null : rawOutput;

  try {
    if (!isDisabled && output === null) {
      await removeOverride(guildId, commandId);
    } else {
      await upsertOverride(guildId, commandId, { isDisabled, output });
    }
    res.redirect('/commands');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Guild command override upsert failed:', err, basePath: '/commands', errorCode: 'override_failed' });
  }
});

/**
 * Removes the per-guild override for a catalog command, reverting it to the catalog default.
 * Accepts `command_id`. Guild ID is always taken from the session.
 */
router.post('/commands/guild-override/reset', requireGuildContext, requireMod, csrfProtection, async (req, res) => {
  const guildId = getSessionUser(req).currentGuildId!;
  const body = req.body as Record<string, unknown>;
  const commandId = parsePositiveIntId(body.command_id as string | string[] | undefined);
  if (!commandId) return res.redirect('/commands?error=invalid_id');

  try {
    await removeOverride(guildId, commandId);
    res.redirect('/commands');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Guild command override reset failed:', err, basePath: '/commands', errorCode: 'override_reset_failed' });
  }
});

export default router;
