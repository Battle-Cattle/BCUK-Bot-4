import { getCustomCommandForDiscord, getCustomCommandForTwitchChannel } from './db';
import { recordCommandTestEntry } from './commandMonitorStore';

function extractCommand(rawMessage: string): string | null {
  const trimmedMessage = rawMessage.trim();
  if (!trimmedMessage) return null;

  const command = trimmedMessage.split(/\s+/)[0]?.toLowerCase();
  return command || null;
}

async function previewCustomCommand(
  rawMessage: string,
  source: 'discord' | 'twitch',
  channel: string | null,
  username: string | null | undefined,
  lookupCommand: (command: string) => Promise<{ output: string } | null>,
  buildLogMessage: (command: string) => string,
): Promise<void> {
  const command = extractCommand(rawMessage);
  if (!command) return;

  const customCommand = await lookupCommand(command);
  if (!customCommand) return;

  recordCommandTestEntry({
    source,
    command,
    response: customCommand.output,
    channel,
    user: username ?? null,
  });

  console.log(buildLogMessage(command));
}

export async function previewCustomCommandForDiscord(
  rawMessage: string,
  username?: string | null,
): Promise<void> {
  await previewCustomCommand(
    rawMessage,
    'discord',
    null,
    username,
    getCustomCommandForDiscord,
    (command) => `[Discord] Preview custom command '${command}' matched (recorded for monitoring).`,
  );
}

export async function previewCustomCommandForTwitch(
  channel: string,
  rawMessage: string,
  username?: string | null,
): Promise<void> {
  await previewCustomCommand(
    rawMessage,
    'twitch',
    channel,
    username,
    (command) => getCustomCommandForTwitchChannel(channel, command),
    (command) => `[Twitch] Preview custom command '${command}' matched in ${channel} (recorded for monitoring).`,
  );
}
