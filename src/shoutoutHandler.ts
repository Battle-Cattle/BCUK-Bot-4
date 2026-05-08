import { CUSTOM_COMMANDS_LIVE_REPLIES } from './config';
import { getUsers, getChannelInfo, getStreams } from './twitchApi';
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

// ─── Message formatting ───────────────────────────────────────────────────────

function formatShoutoutMessage(login: string, gameName: string | null, isLive: boolean): string {
  const url = `twitch.tv/${login}`;
  if (isLive && gameName) return `Go check out @${login}, they're live playing ${gameName}! ${url}`;
  if (gameName) return `Go give @${login} a follow! They were last seen playing ${gameName} — ${url}`;
  return `Go give @${login} a follow at ${url}!`;
}

// ─── Execute ──────────────────────────────────────────────────────────────────

export async function executeShoutoutForTwitch(
  channel: string,
  rawMessage: string,
  username: string | null,
  isModerator: boolean,
): Promise<void> {
  if (extractCommand(rawMessage) !== SO_COMMAND) return;
  if (!isModerator) return;

  const rawTarget = rawMessage.trim().split(/\s+/)[1];
  if (!rawTarget) return;
  const target = rawTarget.replace(/^@/, '').toLowerCase();
  if (!target) return;

  const users = await getUsers([target]);
  const user = users[0];

  if (!user) {
    recordCommandTestEntry({
      source: 'twitch',
      command: SO_COMMAND,
      response: `(unknown user: ${target})`,
      channel,
      user: username,
    });
    return;
  }

  const [channelInfos, streams] = await Promise.all([
    getChannelInfo([user.id]),
    getStreams([user.id]),
  ]);

  const stream = streams[0];
  const gameName = stream?.game_name || channelInfos[0]?.game_name || null;
  const isLive = !!stream;
  const message = formatShoutoutMessage(user.login, gameName || null, isLive);

  recordCommandTestEntry({
    source: 'twitch',
    command: SO_COMMAND,
    response: message,
    channel,
    user: username,
  });

  const runtime = _runtime;
  if (!CUSTOM_COMMANDS_LIVE_REPLIES || !runtime) {
    console.log(`[Twitch] Preview !so in ${channel} — would post: ${message}`);
    return;
  }

  try {
    await runtime.send(channel, message);
    console.log(`[Twitch] Sent !so in ${channel} — ${message}`);
  } catch (err) {
    console.error(`[Twitch] Failed to send !so in ${channel}:`, err);
  }
}
