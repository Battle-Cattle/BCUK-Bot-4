import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { getApprovedGuildIdsForKey } from '../../db';
import { requireApiKey } from '../middleware';
import { getAvailableVoiceChannels } from '../../discord/discordUtils';
import { connect, disconnect } from '../../audio/audioPlayer';
import { normalizeDiscordId } from './shared';
import {
  resolveChannelGuildOrRespond,
  resolvePresenceGuildOrRespond,
  ensureGuildApproved,
  getReadyDiscordClientOrRespond,
} from './streamdeckGuildResolution';

const log = createLogger('Streamdeck');
const router = Router();

/**
 * Lists voice channels across every guild the key is currently approved for.
 * One guild failing to resolve (e.g. the bot was removed from it but its
 * approval row wasn't cleaned up) doesn't block the channel list for every
 * other approved guild — that guild is just reported with an empty list.
 */
router.get('/voice/channels', requireApiKey, async (req, res) => {
  try {
    const guildIds = await getApprovedGuildIdsForKey(req.apiKeyOwner!);
    const results = await Promise.allSettled(
      guildIds.map(async (guildId) => ({ guildId, channels: await getAvailableVoiceChannels(guildId) })),
    );
    const guilds = results.map((result, i) => {
      if (result.status === 'fulfilled') return result.value;
      log.error(`Failed to list voice channels for guild ${guildIds[i]}:`, result.reason);
      return { guildId: guildIds[i], channels: [] };
    });
    res.json({ ok: true, guilds });
  } catch (err) {
    log.error('Failed to list voice channels:', err);
    res.status(500).json({ ok: false, error: 'Failed to fetch voice channels' });
  }
});

/** Disconnects any existing voice connection and joins the voice channel named in the request body. */
router.post('/voice/join', requireApiKey, async (req, res) => {
  const { channelId } = (req.body ?? {}) as { channelId?: unknown };
  if (typeof channelId !== 'string') {
    res.status(400).json({ ok: false, error: 'Missing or invalid "channelId" field' });
    return;
  }
  const normalizedChannelId = normalizeDiscordId(channelId);
  if (!normalizedChannelId) {
    res.status(400).json({ ok: false, error: 'Missing or invalid "channelId" field' });
    return;
  }

  const discordClient = getReadyDiscordClientOrRespond(res);
  if (!discordClient) return;

  const guildId = await resolveChannelGuildOrRespond(req, res, discordClient, normalizedChannelId);
  if (!guildId) return;

  try {
    disconnect(guildId);
    await connect(discordClient, guildId, normalizedChannelId);
    res.json({ ok: true });
  } catch (err) {
    log.error('Voice join failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to join voice channel' });
  }
});

/**
 * Disconnects the bot from its voice channel in the target guild. Accepts an
 * explicit `guildId`, or a `channelId` to resolve one from — the explicit form
 * matters because the channel may no longer exist (e.g. deleted while the bot
 * was connected to it), in which case resolving via channelId alone would
 * leave the bot stuck connected with no way to force a leave. If neither is
 * given (the pre-multi-guild Streamdeck config sends no body at all), falls
 * back to wherever the key owner currently has a live voice connection, the
 * same presence-based resolution `/sfx` uses.
 */
router.post('/voice/leave', requireApiKey, async (req, res) => {
  const { channelId, guildId: rawGuildId } = (req.body ?? {}) as { channelId?: unknown; guildId?: unknown };
  const normalizedChannelId = typeof channelId === 'string' ? normalizeDiscordId(channelId) : null;
  const explicitGuildId = typeof rawGuildId === 'string' ? normalizeDiscordId(rawGuildId) : null;

  let guildId = explicitGuildId;
  if (!guildId) {
    const discordClient = getReadyDiscordClientOrRespond(res);
    if (!discordClient) return;
    guildId = normalizedChannelId
      ? await resolveChannelGuildOrRespond(req, res, discordClient, normalizedChannelId)
      : await resolvePresenceGuildOrRespond(req, res, discordClient);
    if (!guildId) return;
  } else if (!(await ensureGuildApproved(req, res, guildId))) {
    return;
  }

  disconnect(guildId);
  res.json({ ok: true });
});

export default router;
