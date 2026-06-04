import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { getStatus } from '../../shared/statusStore';
import { requireAuth, requireMod } from '../middleware';
import { connect, disconnect, getCurrentChannelId } from '../../audio/audioPlayer';
import { getDiscordClient } from '../../discord/discordBot';
import { csrfProtection } from '../csrf';
import { getAvailableVoiceChannels } from '../../discord/discordUtils';
import { DISCORD_GUILD_ID, DISCORD_VOICE_CHANNEL_ID } from '../../shared/config';

const log = createLogger('API');
const router = Router();

// Live status JSON — polled by the dashboard frontend every few seconds
router.get('/status', requireAuth, (_req, res) => {
  res.json(getStatus());
});

// Get available voice channels — Mod and above
router.get('/voice/channels', requireMod, async (_req, res) => {
  try {
    const channels = await getAvailableVoiceChannels(DISCORD_GUILD_ID);
    res.json({
      ok: true,
      channels,
      defaultChannelId: DISCORD_VOICE_CHANNEL_ID,
      currentChannelId: getCurrentChannelId(),
    });
  } catch (err) {
    log.error('Failed to list voice channels:', err);
    res.status(500).json({ ok: false, error: 'Failed to fetch voice channels' });
  }
});

// Join a specific voice channel or the configured default — Mod and above
router.post('/voice/join', requireMod, csrfProtection, async (req, res) => {
  const discordClient = getDiscordClient();
  if (!discordClient) {
    res.status(503).json({ ok: false, error: 'Discord client not ready' });
    return;
  }
  try {
    const { channelId } = req.body as { channelId?: unknown };
    const trimmedChannelId = typeof channelId === 'string' ? channelId.trim() : '';
    const resolvedChannelId = trimmedChannelId ? trimmedChannelId : undefined;

    disconnect();
    await connect(discordClient, resolvedChannelId);
    res.json({ ok: true });
  } catch (err) {
    log.error('Voice rejoin failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to join voice channel' });
  }
});

// Leave the voice channel — Mod and above
router.post('/voice/leave', requireMod, csrfProtection, (_req, res) => {
  disconnect();
  res.json({ ok: true });
});

export default router;
