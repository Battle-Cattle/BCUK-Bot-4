import { createLogger } from '../shared/logger';
import { getMultiTwitchDataForChannel } from '../twitch/monitor/twitchMonitor';

const log = createLogger('MultiCmd');
import { resolveSharedChatSessionId } from './customCommandHandler';
import { extractCommand } from './commandUtils';
import { sendDedupedBySession } from './twitchBroadcast';
import { createRuntimeRegistry, type TwitchBroadcastRuntime } from './twitchRuntime';
import { createCooldownGate } from './cooldownGate';

const MULTI_COMMAND = '!multi';

// ─── Cooldown ─────────────────────────────────────────────────────────────────
//
// Otherwise unthrottled: any chat member (no permission needed) can spam `!multi`
// as fast as they can send it, and each spam broadcasts to every participant
// channel in the shared-chat group — the cost scales with group size. Gated per
// source channel, mirroring counterHandler.ts's per-channel cooldown.

const multiCooldown = createCooldownGate();

// ─── Twitch runtime (registered from index.ts before startTwitchBot) ─────────
//
// Same injection pattern as customCommandHandler.ts to avoid a circular import
// between twitchBot.ts and multiCommandHandler.ts.

type MultiTwitchRuntime = TwitchBroadcastRuntime;

const multiTwitchRuntime = createRuntimeRegistry<MultiTwitchRuntime>();

/** Stores the concrete Twitch chat runtime (send/getActiveChannels/getLoginUserIds) so `!multi` can be broadcast. Call once from index.ts after the Twitch bot is ready. */
export function registerMultiTwitchRuntime(runtime: MultiTwitchRuntime): void {
  multiTwitchRuntime.register(runtime);
}

// ─── Broadcast ────────────────────────────────────────────────────────────────

/**
 * Broadcasts `message` (the `!multi` URL) to the source channel plus every other
 * participant channel the bot has currently joined, de-duplicating channels that
 * share a Twitch shared-chat session via {@link sendDedupedBySession} so only one
 * message is sent per session.
 * @returns True if the message was sent to at least one channel/session.
 */
async function broadcastToGroupChannels(
  sourceChannel: string,
  participants: string[],
  message: string,
  runtime: MultiTwitchRuntime,
): Promise<boolean> {
  const { send, getActiveChannels, getLoginUserIds } = runtime;
  const activeChannels = getActiveChannels();
  const loginUserIds = getLoginUserIds();

  // Source channel first, then the remaining participants — filter to channels the bot has joined
  const targets = [sourceChannel, ...participants.filter((p) => p !== sourceChannel)]
    .filter((ch) => activeChannels.has(ch));

  return sendDedupedBySession(targets, loginUserIds, message, send, resolveSharedChatSessionId);
}

// ─── Execute ──────────────────────────────────────────────────────────────────

/**
 * Handles a Twitch chat `!multi` command: looks up the multitwitch group for
 * `channel` and — if the channel is part of an active group — broadcasts the
 * multitwitch URL to the group via {@link broadcastToGroupChannels}. Throttled
 * per source channel so repeated spam doesn't repeatedly broadcast to the whole
 * group.
 *
 * @param channel - Twitch channel the command was sent in.
 * @param rawMessage - Raw chat message text.
 * @param username - Twitch login of the sender (unused).
 * @returns Resolves once the broadcast (or a no-op) has completed.
 */
export async function executeMultiCommandForTwitch(
  channel: string,
  rawMessage: string,
  username?: string | null,
): Promise<void> {
  const command = extractCommand(rawMessage);
  if (command !== MULTI_COMMAND) return;

  const groupInfo = getMultiTwitchDataForChannel(channel);

  if (!groupInfo) return;

  const runtime = multiTwitchRuntime.get();
  if (!runtime) return;

  if (!multiCooldown.tryClaim(`twitch:${channel}`)) return;

  try {
    const sent = await broadcastToGroupChannels(channel, groupInfo.participants, groupInfo.url, runtime);
    if (sent) {
      log.info(`[Twitch] Sent !multi in ${channel} — ${groupInfo.url}`);
    } else {
      log.info(`[Twitch] Broadcast !multi in ${channel} reached no channels.`);
    }
  } catch (err) {
    log.error(`[Twitch] Failed to broadcast !multi in ${channel}:`, err);
  }
}
