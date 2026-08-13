import { createLogger } from '../../shared/logger';
import { Router, type Request, type Response } from 'express';
import { getGuildScopedStatus } from '../guildScopedStatus';
import { requireAuth, requireGuildContext, requireMod } from '../middleware';
import { connect, disconnect, getCurrentChannelId } from '../../audio/audioPlayer';
import { csrfProtection } from '../csrf';
import { getAvailableVoiceChannels } from '../../discord/discordUtils';
import { getGuildById } from '../../db';
import { normalizeDiscordId } from './shared';
import { getReadyDiscordClientOrRespond } from './streamdeckGuildResolution';

const log = createLogger('API');
const router = Router();

/**
 * Resolves the guild the request acts in from the session, replying 400 when no
 * guild is selected. Voice and status routes are guild-scoped — the bot can hold
 * a separate connection per guild — and the guild is taken from the session
 * (never the request body) so a Mod cannot drive or view another guild's state.
 *
 * @returns The current guild ID, or null when the response has already been sent.
 */
function getSessionGuildId(req: Request, res: Response): string | null {
  const guildId = req.session.user?.currentGuildId ?? null;
  if (!guildId) {
    res.status(400).json({ ok: false, error: 'No guild selected' });
    return null;
  }
  return guildId;
}

/**
 * GET /status — live bot status JSON, polled by the dashboard frontend every
 * few seconds. Voice status, the Discord "Server" name, and Twitch channels
 * are all scoped to the viewer's current guild so a Manager on guild B's
 * dashboard never sees guild A's now-playing info, server name, or Twitch
 * channels.
 * @param req - Express request; guild is taken from the session.
 * @param res - Express response; returns `getGuildScopedStatus(guildId)`, 400
 *   if no guild is selected, or 500 if the lookup fails.
 */
router.get('/status', requireAuth, async (req, res) => {
  const guildId = getSessionGuildId(req, res);
  if (!guildId) return;
  try {
    res.json(await getGuildScopedStatus(guildId));
  } catch (err) {
    log.error('Failed to fetch status:', err);
    res.status(500).json({ ok: false, error: 'Failed to fetch status' });
  }
});

/**
 * GET /voice/channels — lists the current guild's available voice channels
 * along with the configured default and currently-connected channel (Mod+).
 * @param req - Express request; guild is taken from the session.
 * @param res - Express response; JSON `{ ok: true, channels, defaultChannelId,
 *   currentChannelId }` on success, 400 if no guild is selected, or 500 on
 *   failure.
 */
router.get('/voice/channels', requireGuildContext, requireMod, async (req, res) => {
  const guildId = getSessionGuildId(req, res);
  if (!guildId) return;
  try {
    const [channels, guild] = await Promise.all([
      getAvailableVoiceChannels(guildId),
      getGuildById(guildId),
    ]);
    res.json({
      ok: true,
      channels,
      defaultChannelId: guild?.voice_channel_id ?? null,
      currentChannelId: getCurrentChannelId(guildId),
    });
  } catch (err) {
    log.error('Failed to list voice channels:', err);
    res.status(500).json({ ok: false, error: 'Failed to fetch voice channels' });
  }
});

/**
 * POST /voice/join — joins a specific voice channel, or the guild's configured
 * default channel if none is supplied (Mod+).
 * @param req - Express request; reads `channelId` from `req.body`; guild is
 *   taken from the session.
 * @param res - Express response; JSON `{ ok: true }` on success, 400 if no
 *   guild is selected, `channelId` is malformed, or no channel is resolvable,
 *   503 if the Discord client isn't ready, or 500 on failure.
 */
router.post('/voice/join', requireGuildContext, requireMod, csrfProtection, async (req, res) => {
  const guildId = getSessionGuildId(req, res);
  if (!guildId) return;

  const discordClient = getReadyDiscordClientOrRespond(res);
  if (!discordClient) return;
  try {
    const { channelId } = req.body as { channelId?: unknown };
    if (channelId !== undefined && typeof channelId !== 'string') {
      res.status(400).json({ ok: false, error: 'channelId must be a string' });
      return;
    }
    const trimmedChannelId = typeof channelId === 'string' ? channelId.trim() : '';
    if (trimmedChannelId && !normalizeDiscordId(trimmedChannelId)) {
      res.status(400).json({ ok: false, error: 'Invalid channel ID' });
      return;
    }
    // Fall back to the guild's configured default channel when none is supplied.
    const resolvedChannelId = trimmedChannelId || (await getGuildById(guildId))?.voice_channel_id || undefined;
    if (!resolvedChannelId) {
      res.status(400).json({ ok: false, error: 'No voice channel selected and no default configured' });
      return;
    }

    disconnect(guildId);
    await connect(discordClient, guildId, resolvedChannelId);
    res.json({ ok: true });
  } catch (err) {
    log.error('Voice rejoin failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to join voice channel' });
  }
});

/**
 * POST /voice/leave — disconnects from the current guild's voice channel
 * (Mod+).
 * @param req - Express request; guild is taken from the session.
 * @param res - Express response; JSON `{ ok: true }` on success, or 400 if no
 *   guild is selected.
 */
router.post('/voice/leave', requireGuildContext, requireMod, csrfProtection, (req, res) => {
  const guildId = getSessionGuildId(req, res);
  if (!guildId) return;
  disconnect(guildId);
  res.json({ ok: true });
});

export default router;
