import { createLogger } from '../../shared/logger';
import { Router, type Request, type Response } from 'express';
import { getStatus } from '../../shared/statusStore';
import { requireAuth, requireMod } from '../middleware';
import { connect, disconnect, getCurrentChannelId } from '../../audio/audioPlayer';
import { getDiscordClient } from '../../discord/discordBot';
import { csrfProtection } from '../csrf';
import { getAvailableVoiceChannels } from '../../discord/discordUtils';
import { getGuildById } from '../../db';
import { normalizeDiscordId } from './shared';

const log = createLogger('API');
const router = Router();

/**
 * Resolves the guild the request acts in from the session, replying 400 when no
 * guild is selected. Voice routes are guild-scoped — the bot can hold a separate
 * connection per guild — and the guild is taken from the session (never the
 * request body) so a Mod cannot drive another guild's voice connection.
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

// Live status JSON — polled by the dashboard frontend every few seconds
router.get('/status', requireAuth, (_req, res) => {
  res.json(getStatus());
});

// Get available voice channels for the current guild — Mod and above
router.get('/voice/channels', requireMod, async (req, res) => {
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

// Join a specific voice channel, or the guild's configured default — Mod and above
router.post('/voice/join', requireMod, csrfProtection, async (req, res) => {
  const guildId = getSessionGuildId(req, res);
  if (!guildId) return;

  const discordClient = getDiscordClient();
  if (!discordClient) {
    res.status(503).json({ ok: false, error: 'Discord client not ready' });
    return;
  }
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

// Leave the current guild's voice channel — Mod and above
router.post('/voice/leave', requireMod, csrfProtection, (req, res) => {
  const guildId = getSessionGuildId(req, res);
  if (!guildId) return;
  disconnect(guildId);
  res.json({ ok: true });
});

export default router;
