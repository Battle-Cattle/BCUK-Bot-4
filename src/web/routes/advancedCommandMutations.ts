// POST routes behind the /advanced-commands page: add, update, enable/disable, delete, save
// effects, and send a test. Each resolves the session user's streamer and only touches that
// streamer's commands (the DB layer scopes every write by streamer_id). Failures redirect to
// `/advanced-commands?error=<code>`; nothing is rendered from a POST.
import { createLogger } from '../../shared/logger';
import { Router, type Request, type Response } from 'express';
import {
  addAdvancedCommand,
  getVideosForStreamer,
  removeAdvancedCommand,
  saveAdvancedCommandEffects,
  setAdvancedCommandEnabled,
  updateAdvancedCommand,
  type DbStreamerEventSub,
} from '../../db';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { requireStreamer } from './viewHelpers';
import { logAndRedirectError, redirectWithError } from './errorHandling';
import { parsePositiveIntId } from './validation';
import { advancedCommandErrorCode, parseEffectsForm, parseSettingsForm, type FormBody } from './advancedCommandForms';
import { BASE_PATH, NOT_A_STREAMER_REDIRECT } from './advancedCommandPaths';
import { removeAlertAssetFiles } from './advancedCommandAlertAssets';
import { triggerAdvancedCommandFromStreamDeck } from '../../commands/advancedCommands/advancedCommandHandler';

const log = createLogger('Web');
export const router = Router();

/** What a route handler reports: a `?success=` code, or a `?error=` code. */
type Outcome = { success: string } | { error: string };

/** A handler for one command route, given the verified streamer and the parsed command id. */
type CommandAction = (streamer: DbStreamerEventSub, commandId: number, body: FormBody) => Promise<Outcome>;

/**
 * Redirects back to the page with an outcome code.
 * @param res - The response.
 * @param outcome - Success or error code.
 */
function redirectWith(res: Response, outcome: Outcome): void {
  if ('error' in outcome) {
    redirectWithError(res, BASE_PATH, outcome.error);
  } else {
    res.redirect(`${BASE_PATH}?success=${outcome.success}`);
  }
}

/**
 * Handles an error thrown by a route: expected validation/conflict errors redirect with their
 * code; anything else is logged and shown as `save_failed`.
 * @param res - The response.
 * @param err - The caught error.
 * @param logLabel - Log prefix for an unexpected error.
 */
function handleError(res: Response, err: unknown, logLabel: string): void {
  const code = advancedCommandErrorCode(err);
  if (code) {
    redirectWith(res, { error: code });
    return;
  }
  logAndRedirectError({ res, log, logLabel, err, basePath: BASE_PATH, errorCode: 'save_failed' });
}

/**
 * Builds a handler for a `/advanced-commands/:id/...` route: resolves the streamer, parses `:id`,
 * runs `action`, and redirects with its outcome.
 * @param action - The route's work.
 * @param logLabel - Log prefix for an unexpected error.
 * @returns The Express handler.
 */
function commandRoute(action: CommandAction, logLabel: string) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const streamer = await requireStreamer(req, res, NOT_A_STREAMER_REDIRECT);
      if (!streamer) return;
      const commandId = parsePositiveIntId(req.params.id);
      if (commandId === null) return redirectWith(res, { error: 'not_found' });
      redirectWith(res, await action(streamer, commandId, req.body as FormBody));
    } catch (err) {
      handleError(res, err, logLabel);
    }
  };
}

/**
 * POST /advanced-commands/add — creates a command for the signed-in streamer.
 * @param req - Express request; the settings form body.
 * @param res - Redirects with `?success=added` or `?error=<code>`.
 */
router.post(`${BASE_PATH}/add`, requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res, NOT_A_STREAMER_REDIRECT);
    if (!streamer) return;
    await addAdvancedCommand(streamer.id, parseSettingsForm(req.body as FormBody));
    redirectWith(res, { success: 'added' });
  } catch (err) {
    handleError(res, err, 'Advanced command add error:');
  }
});

/**
 * POST /advanced-commands/:id/update — replaces one of the streamer's commands' settings.
 * @param req - Express request; the settings form body.
 * @param res - Redirects with `?success=saved` or `?error=<code>`.
 */
router.post(`${BASE_PATH}/:id/update`, requireAuth, csrfProtection, commandRoute(async (streamer, id, body) => {
  const found = await updateAdvancedCommand(streamer.id, id, parseSettingsForm(body));
  return found ? { success: 'saved' } : { error: 'not_found' };
}, 'Advanced command update error:'));

/**
 * POST /advanced-commands/:id/toggle — flips one of the streamer's commands on or off.
 * @param req - Express request.
 * @param res - Redirects with `?success=toggled` or `?error=not_found`.
 */
router.post(`${BASE_PATH}/:id/toggle`, requireAuth, csrfProtection, commandRoute(async (streamer, id) => {
  const state = await setAdvancedCommandEnabled(streamer.id, id);
  return state === null ? { error: 'not_found' } : { success: 'toggled' };
}, 'Advanced command toggle error:'));

/**
 * POST /advanced-commands/:id/remove — deletes one of the streamer's commands and its alert files.
 * @param req - Express request.
 * @param res - Redirects with `?success=removed` or `?error=not_found`.
 */
router.post(`${BASE_PATH}/:id/remove`, requireAuth, csrfProtection, commandRoute(async (streamer, id) => {
  const orphaned = await removeAdvancedCommand(streamer.id, id);
  if (orphaned === null) return { error: 'not_found' };
  await removeAlertAssetFiles(streamer.id, orphaned);
  return { success: 'removed' };
}, 'Advanced command remove error:'));

/**
 * POST /advanced-commands/:id/effects — saves one of the streamer's commands' parameters,
 * overlay videos and alert. Removing the alert deletes its uploaded files.
 * @param req - Express request; the effects form body.
 * @param res - Redirects with `?success=effects_saved` or `?error=<code>`.
 */
router.post(`${BASE_PATH}/:id/effects`, requireAuth, csrfProtection, commandRoute(async (streamer, id, body) => {
  const videoIds = (await getVideosForStreamer(streamer.id)).map((v) => v.id);
  const orphaned = await saveAdvancedCommandEffects(streamer.id, id, parseEffectsForm(body, videoIds));
  if (orphaned === null) return { error: 'not_found' };
  await removeAlertAssetFiles(streamer.id, orphaned);
  return { success: 'effects_saved' };
}, 'Advanced command effects error:'));

/**
 * POST /advanced-commands/:id/test — fires one of the streamer's commands exactly as their Stream
 * Deck would (free, skipping the chat gates), to preview its effects.
 * @param req - Express request.
 * @param res - Redirects with `?success=test_sent` or `?error=<code>`.
 */
router.post(`${BASE_PATH}/:id/test`, requireAuth, csrfProtection, commandRoute(async (streamer, id) => {
  if (!streamer.twitch_name) return { error: 'not_a_streamer' };
  const result = await triggerAdvancedCommandFromStreamDeck(
    { id: streamer.id, discordId: streamer.discord_id, twitchName: streamer.twitch_name },
    id,
  );
  if (result === 'ok') return { success: 'test_sent' };
  return { error: result === 'command_not_found' ? 'not_found' : 'command_disabled' };
}, 'Advanced command test error:'));
