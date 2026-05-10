import { getCustomCommandsLiveReplies } from './monitorSettings';
import { getMultiTwitchDataForChannel } from './twitchMonitor';
import { recordCommandTestEntry } from './commandMonitorStore';
import { resolveSharedChatSessionId } from './customCommandHandler';
import { extractCommand } from './commandUtils';

const MULTI_COMMAND = '!multi';

// ─── Twitch runtime (registered from index.ts before startTwitchBot) ─────────
//
// Same injection pattern as customCommandHandler.ts to avoid a circular import
// between twitchBot.ts and multiCommandHandler.ts.

interface MultiTwitchRuntime {
  send: (channel: string, message: string) => Promise<void>;
  getActiveChannels: () => ReadonlySet<string>;
  getLoginUserIds: () => ReadonlyMap<string, string>;
}

let _runtime: MultiTwitchRuntime | null = null;

export function registerMultiTwitchRuntime(runtime: MultiTwitchRuntime): void {
  _runtime = runtime;
}

// ─── Broadcast ────────────────────────────────────────────────────────────────

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

  // Pre-resolve all session IDs in parallel to avoid serial Helix calls per channel
  const userIds = [...new Set(targets.map((ch) => loginUserIds.get(ch)).filter((id): id is string => id !== undefined))];
  const resolvedIds = await Promise.all(userIds.map((uid) => resolveSharedChatSessionId(uid)));
  const sessionIdByUserId = new Map(userIds.map((uid, i) => [uid, resolvedIds[i]]));

  const repliedSessionIds = new Set<string>();

  for (const channel of targets) {
    const userId = loginUserIds.get(channel);
    const sessionId = userId ? (sessionIdByUserId.get(userId) ?? null) : null;

    if (sessionId && repliedSessionIds.has(sessionId)) continue;

    try {
      await send(channel, message);
      if (sessionId) repliedSessionIds.add(sessionId);
    } catch (err) {
      console.error(`[MultiCmd] Failed to send to ${channel}:`, err);
    }
  }
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

  const runtime = _runtime;
  if (!getCustomCommandsLiveReplies() || !runtime) {
    console.log(`[Twitch] Preview !multi in ${channel} — would post: ${groupInfo.url}`);
    return;
  }

  try {
    await broadcastToGroupChannels(channel, groupInfo.participants, groupInfo.url, runtime);
    console.log(`[Twitch] Sent !multi in ${channel} — ${groupInfo.url}`);
  } catch (err) {
    console.error(`[Twitch] Failed to broadcast !multi in ${channel}:`, err);
  }
}
