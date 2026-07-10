import { createLogger } from '../../shared/logger';
import { Router, type Request, type Response } from 'express';
import { Client } from 'discord.js';
import { findTrigger, findSoundFiles, getAllSfxTriggers, isKeyApprovedForGuild, getApprovedGuildIdsForKey } from '../../db';
import { pickWeightedRandom } from '../../commands/soundSelector';
import { playFile, VoiceNotConnectedError } from '../../audio/sfxPlayer';
import { setVoicePlaying } from '../../shared/statusStore';
import { requireApiKey } from '../middleware';
import { getAvailableVoiceChannels } from '../../discord/discordUtils';
import { connect, disconnect } from '../../audio/audioPlayer';
import { getDiscordClient } from '../../discord/discordBot';
import { getActiveGuildForUser } from '../../discord/voicePresence';
import { normalizeDiscordId } from './shared';

const log = createLogger('Streamdeck');
const router = Router();

/**
 * Resolves which guild a voice-channel ID belongs to, or null if the channel
 * doesn't exist / isn't a guild channel.
 */
async function resolveGuildIdFromChannelId(client: Client, channelId: string): Promise<string | null> {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !('guildId' in channel)) return null;
    return channel.guildId ?? null;
  } catch {
    return null;
  }
}

/**
 * Confirms the request's API key is approved for `guildId`, sending a generic
 * 403 and returning false if not. Shared by every route below so approval
 * denial always produces the same response.
 */
async function ensureGuildApproved(req: Request, res: Response, guildId: string): Promise<boolean> {
  if (!(await isKeyApprovedForGuild(req.apiKeyOwner!, guildId))) {
    res.status(403).json({ ok: false, error: 'Key not approved for this guild' });
    return false;
  }
  return true;
}

/**
 * Resolves the guild a channel-scoped Streamdeck action (join/leave) should
 * target from the request's own `channelId`, and confirms the key is approved
 * for that guild. Sends the appropriate error response and returns null on
 * any failure.
 */
async function resolveChannelGuildOrRespond(req: Request, res: Response, client: Client, channelId: string): Promise<string | null> {
  const guildId = await resolveGuildIdFromChannelId(client, channelId);
  if (!guildId) {
    res.status(400).json({ ok: false, error: 'Unknown voice channel' });
    return null;
  }
  return (await ensureGuildApproved(req, res, guildId)) ? guildId : null;
}

/**
 * Resolves the guild a presence-scoped Streamdeck action (e.g. play SFX)
 * should target: wherever the key owner currently has a live voice-channel
 * connection, since a Discord account can only be in one voice channel across
 * every server at a time. Sends the appropriate error response and returns
 * null on any failure.
 */
async function resolvePresenceGuildOrRespond(req: Request, res: Response, client: Client): Promise<string | null> {
  const guildId = getActiveGuildForUser(client, req.apiKeyOwner!);
  if (!guildId) {
    res.status(503).json({ ok: false, error: 'Not currently connected to a voice channel in any server' });
    return null;
  }
  return (await ensureGuildApproved(req, res, guildId)) ? guildId : null;
}

/** Lists all SFX triggers available to play via Streamdeck. */
router.get('/sfx', requireApiKey, async (_req, res) => {
  try {
    const triggers = await getAllSfxTriggers();
    res.json({ ok: true, triggers });
  } catch (err) {
    log.error('Failed to list triggers:', err);
    res.status(500).json({ ok: false, error: 'Failed to fetch triggers' });
  }
});

/**
 * Plays a random weighted sound file for the SFX trigger named in the request
 * body, in whichever guild the key owner is currently connected to voice in.
 */
router.post('/sfx', requireApiKey, async (req, res) => {
  const { command } = req.body as { command?: unknown };
  if (typeof command !== 'string' || !command.trim()) {
    res.status(400).json({ ok: false, error: 'Missing or invalid "command" field' });
    return;
  }

  const discordClient = getDiscordClient();
  if (!discordClient) {
    res.status(503).json({ ok: false, error: 'Discord client not ready' });
    return;
  }
  const guildId = await resolvePresenceGuildOrRespond(req, res, discordClient);
  if (!guildId) return;

  const normalizedCommand = command.trim().toLowerCase();

  let trigger;
  try {
    trigger = await findTrigger(normalizedCommand);
  } catch (err) {
    log.error('DB error looking up trigger:', err);
    res.status(500).json({ ok: false, error: 'Database error' });
    return;
  }
  if (!trigger) {
    res.status(404).json({ ok: false, error: 'Unknown command' });
    return;
  }

  let files;
  try {
    files = await findSoundFiles(trigger.id);
  } catch (err) {
    log.error('DB error fetching sound files:', err);
    res.status(500).json({ ok: false, error: 'Database error' });
    return;
  }
  if (files.length === 0) {
    res.status(404).json({ ok: false, error: 'No sound files for this command' });
    return;
  }

  const filename = pickWeightedRandom(files);

  try {
    playFile(filename, guildId);
    setVoicePlaying(filename, normalizedCommand, 'streamdeck');
    log.info(`Playing '${filename.replace(/[\r\n]/g, '')}' for trigger '${normalizedCommand.replace(/[\r\n]/g, '')}' in guild ${guildId}`);
    res.json({ ok: true, file: filename });
  } catch (err: unknown) {
    if (err instanceof VoiceNotConnectedError) {
      res.status(503).json({ ok: false, error: 'Bot is not connected to a voice channel' });
    } else {
      log.error(`Failed to play ${filename.replace(/[\r\n]/g, '')}:`, err);
      res.status(500).json({ ok: false, error: 'Failed to play sound' });
    }
  }
});

/** Lists voice channels across every guild the key is currently approved for. */
router.get('/voice/channels', requireApiKey, async (req, res) => {
  try {
    const guildIds = await getApprovedGuildIdsForKey(req.apiKeyOwner!);
    const guilds = await Promise.all(
      guildIds.map(async (guildId) => ({ guildId, channels: await getAvailableVoiceChannels(guildId) })),
    );
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
