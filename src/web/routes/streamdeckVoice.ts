import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { getApprovedGuildIdsForKey } from '../../db';
import { requireApiKey } from '../middleware';
import { getAvailableVoiceChannels } from '../../discord/discordUtils';
import { connect, disconnect } from '../../audio/audioPlayer';
import { getDiscordClient } from '../../discord/discordBot';
import { normalizeDiscordId } from './shared';
import {
  resolveGuildIdFromChannelId,
  resolveChannelGuildOrRespond,
  ensureGuildApproved,
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
  const { channelId } = req.body as { channelId?: unknown };
  if (typeof channelId !== 'string') {
    res.status(400).json({ ok: false, error: 'Missing or invalid "channelId" field' });
    return;
  }
  const normalizedChannelId = normalizeDiscordId(channelId);
  if (!normalizedChannelId) {
    res.status(400).json({ ok: false, error: 'Missing or invalid "channelId" field' });
    return;
  }

  const discordClient = getDiscordClient();
  if (!discordClient) {
    res.status(503).json({ ok: false, error: 'Discord client not ready' });
    return;
  }

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
 * explicit `guildId`, or falls back to resolving it from `channelId` — the
 * explicit form matters because the channel may no longer exist (e.g. deleted
 * while the bot was connected to it), in which case resolving via channelId
 * alone would leave the bot stuck connected with no way to force a leave.
 */
router.post('/voice/leave', requireApiKey, async (req, res) => {
  const { channelId, guildId: rawGuildId } = req.body as { channelId?: unknown; guildId?: unknown };
  const normalizedChannelId = typeof channelId === 'string' ? normalizeDiscordId(channelId) : null;
  const explicitGuildId = typeof rawGuildId === 'string' ? normalizeDiscordId(rawGuildId) : null;
  if (!normalizedChannelId && !explicitGuildId) {
    res.status(400).json({ ok: false, error: 'Missing or invalid "channelId" or "guildId" field' });
    return;
  }

  let guildId = explicitGuildId;
  if (!guildId) {
    const discordClient = getDiscordClient();
    if (!discordClient) {
      res.status(503).json({ ok: false, error: 'Discord client not ready' });
      return;
    }
    guildId = await resolveGuildIdFromChannelId(discordClient, normalizedChannelId!);
    if (!guildId) {
      res.status(400).json({ ok: false, error: 'Unknown voice channel' });
      return;
    }
  }

  if (!(await ensureGuildApproved(req, res, guildId))) return;

  disconnect(guildId);
  res.json({ ok: true });
});

export default router;
