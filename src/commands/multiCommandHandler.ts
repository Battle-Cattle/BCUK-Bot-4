import { createLogger } from '../shared/logger';
import { getMultiTwitchDataForChannel } from '../twitch/monitor/twitchMonitor';

const log = createLogger('MultiCmd');
import { recordCommandTestEntry } from './commandMonitorStore';
import { resolveSharedChatSessionId } from './customCommandHandler';
import { extractCommand } from './commandUtils';
import { sendDedupedBySession } from './twitchBroadcast';
import { createRuntimeRegistry, type TwitchSendRuntime } from './twitchRuntime';

const MULTI_COMMAND = '!multi';

// ─── Twitch runtime (registered from index.ts before startTwitchBot) ─────────
//
// Same injection pattern as customCommandHandler.ts to avoid a circular import
// between twitchBot.ts and multiCommandHandler.ts.

interface MultiTwitchRuntime extends TwitchSendRuntime {
  getActiveChannels: () => ReadonlySet<string>;
  getLoginUserIds: () => ReadonlyMap<string, string>;
}

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
 */
async function broadcastToGroupChannels(
  sourceChannel: string,
  participants: string[],
  message: string,
  runtime: MultiTwitchRuntime,
): Promise<void> {
  const { send, getActiveChannels, getLoginUserIds } = runtime;
  const activeChannels = getActiveChannels();
  const loginUserIds = getLoginUserIds();

  // Source channel first, then the remaining participants — filter to channels the bot has joined
  const targets = [sourceChannel, ...participants.filter((p) => p !== sourceChannel)]
    .filter((ch) => activeChannels.has(ch));

  await sendDedupedBySession(targets, loginUserIds, message, send, resolveSharedChatSessionId);
}

// ─── Execute ──────────────────────────────────────────────────────────────────

export async function executeMultiCommandForTwitch(
  channel: string,
  rawMessage: string,
  username?: string | null,
): Promise<void> {
  const command = extractCommand(rawMessage);
  if (command !== MULTI_COMMAND) return;

  const groupInfo = getMultiTwitchDataForChannel(channel);

  recordCommandTestEntry({
    source: 'twitch',
    command: MULTI_COMMAND,
    response: groupInfo?.url ?? '(not in an active multitwitch group)',
    channel,
    user: username ?? null,
  });

  if (!groupInfo) return;

  const runtime = multiTwitchRuntime.get();
  if (!runtime) return;

  try {
    await broadcastToGroupChannels(channel, groupInfo.participants, groupInfo.url, runtime);
    log.info(`[Twitch] Sent !multi in ${channel} — ${groupInfo.url}`);
  } catch (err) {
    log.error(`[Twitch] Failed to broadcast !multi in ${channel}:`, err);
  }
}
