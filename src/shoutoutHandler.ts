import { getUsers, getChannelInfo, getStreams, TwitchChannelInfo, TwitchStream } from './twitchApi';
import { recordCommandTestEntry } from './commandMonitorStore';
import { extractCommand } from './commandUtils';

const SO_COMMAND = '!so';

// ─── Twitch runtime (registered from index.ts before startTwitchBot) ─────────

interface ShoutoutRuntime {
  send: (channel: string, message: string) => Promise<void>;
}

let _runtime: ShoutoutRuntime | null = null;

export function registerShoutoutRuntime(runtime: ShoutoutRuntime): void {
  _runtime = runtime;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatShoutoutMessage(login: string, gameName: string | null, isLive: boolean): string {
  const url = `twitch.tv/${login}`;
  if (isLive && gameName) return `Go check out @${login}, they're live playing ${gameName}! ${url}`;
  if (gameName) return `Go give @${login} a follow! They were last seen playing ${gameName} — ${url}`;
  return `Go give @${login} a follow at ${url}!`;
}

async function resolveShoutoutData(
  target: string,
): Promise<{ login: string; gameName: string | null; isLive: boolean } | null> {
  const users = await getUsers([target]);
  const user = users[0];
  if (!user) return null;

  // Independent failures: a bad getStreams response still lets getChannelInfo succeed.
  const [channelResult, streamsResult] = await Promise.allSettled([
    getChannelInfo([user.id]),
    getStreams([user.id]),
  ]);

  const channelInfos: TwitchChannelInfo[] = channelResult.status === 'fulfilled' ? channelResult.value : [];
  const streams: TwitchStream[] = streamsResult.status === 'fulfilled' ? streamsResult.value : [];
  const stream = streams[0];

  return {
    login: user.login,
    gameName: stream?.game_name || channelInfos[0]?.game_name || null,
    isLive: !!stream,
  };
}

async function dispatchShoutout(channel: string, message: string): Promise<void> {
  const runtime = _runtime;
  if (!runtime) return;
  try {
    await runtime.send(channel, message);
    console.log(`[Twitch] Sent !so in ${channel} — ${message}`);
  } catch (err) {
    console.error(`[Twitch] Failed to send !so in ${channel}:`, err);
  }
}

// ─── Execute ──────────────────────────────────────────────────────────────────

export async function executeShoutoutForTwitch(
  channel: string,
  rawMessage: string,
  username: string | null,
  isModerator: boolean,
): Promise<void> {
  if (extractCommand(rawMessage) !== SO_COMMAND || !isModerator) return;

  const rawTarget = rawMessage.trim().split(/\s+/)[1];
  const target = rawTarget?.replace(/^@/, '').toLowerCase();
  if (!target) return;

  const data = await resolveShoutoutData(target);
  const response = data
    ? formatShoutoutMessage(data.login, data.gameName, data.isLive)
    : `(unknown user: ${target})`;

  recordCommandTestEntry({ source: 'twitch', command: SO_COMMAND, response, channel, user: username });

  if (data) {
    await dispatchShoutout(channel, response);
  }
}
